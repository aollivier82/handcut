// What hands do to the workspace.
//
//   fingertip   presses keys, taps pills to select, swipes the belt and the
//               library like a phone screen
//   pinch       grabs things: a pill's body (move), a pill's end (trim), the
//               brass dial (scrub), a recording from the library, the desk bar
//   two pinches pills held end to end for two seconds merge into one
//   open hand   chopped down through the selected pill cuts it at the line
//
// A mouse drives the same gestures on a computer.

import * as THREE from 'three';
import { LAY, laneY } from './stage.js';
import { FPS, clipLen, snapFrames } from './model.js';
import { sfx, chargeTone } from './sfx.js';
import { clamp } from './ui3d.js';

const V = () => new THREE.Vector3();
const _n = V();
const _a = V();

export class Interact {
  constructor({ stage, editor, hands, library, player, app, camera, canvas }) {
    Object.assign(this, { stage, editor, hands, library, player, app, camera, canvas });
    this.merge = 0;
    this.beltVel = 0; // metres per second of film still coasting after a flick
    this.beltTouch = null;
    this.chopAfter = 0;
    this.snapKey = null;
    this.mouse = { side: 'mouse', memo: { pb: V(), pc: V(), pl: V() }, drag: null, down: null, pinchWorld: V(), speed: 0 };
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.bindMouse();
  }

  // ---- hands -------------------------------------------------------------

  update(dt, now, inXR) {
    const { stage, editor: ed } = this;
    stage.hot.id = stage.hot.edge = null;
    let armed = 0;
    if (inXR) {
      const list = this.hands.list;
      for (const h of list) {
        const m = h.memo;
        if (!h.tracked) {
          if (h.drag && h.lostFor > 260) {
            h.drag.cancel();
            h.drag = null;
          }
          this.letGo(h);
          continue;
        }
        (m.tb ||= V()).copy(h.tip).applyMatrix4(stage.benchInv);
        (m.tc ||= V()).copy(h.tip).applyMatrix4(stage.consoleInv);
        (m.tl ||= V()).copy(h.tip).applyMatrix4(stage.libInv);
        (m.pb ||= V()).copy(h.pinch).applyMatrix4(stage.benchInv);
        (m.pc ||= V()).copy(h.pinch).applyMatrix4(stage.consoleInv);
        (m.pl ||= V()).copy(h.pinch).applyMatrix4(stage.libInv);
        if (h.mute && !h.pinching) h.mute = false;
      }

      for (const h of list) {
        if (!h.tracked) continue;
        // keys
        if (!h.drag && !h.pinching) {
          for (const b of stage.buttons) if (b.touch(h.side, h.tip, h.hasPrev ? h.tipPrev : null, h.tipRadius, now)) break;
        } else for (const b of stage.buttons) b.release(h.side);

        // pinch grabs
        if (h.pinchStarted && !h.drag && !h.mute) {
          this.player.unblock();
          h.drag = this.pick(h, now);
        }
        if (h.drag) {
          if (!h.pinching) {
            h.drag.end(h);
            h.drag = null;
          } else h.drag.move(h, dt, now);
        } else if (!h.pinching) this.hoverHandles(h);
      }

      this.updateMerge(dt, now);

      for (const h of list) {
        if (!h.tracked) continue;
        const free = !h.drag && !h.pinching;
        this.beltFinger(h, free, dt, now);
        this.libFinger(h, free, dt, now);
        if (free) this.tapPills(h, dt, now);
        armed = Math.max(armed, this.chop(h, free, dt, now));
      }
    }
    stage.armed = armed;
    this.coast(dt);
  }

  letGo(h) {
    const m = h.memo;
    for (const b of this.stage.buttons) b.release(h.side);
    if (m.belt) this.endBelt(h);
    if (m.lib) {
      m.lib = null;
      this.stage.libTouching = false;
    }
    m.touching = null;
    m.bladeOk = false;
  }

  hoverHandles(h) {
    const hit = this.stage.pillAt(h.memo.pb, 0.02, 0.07);
    if (hit && hit.zone !== 'body') {
      this.stage.hot.id = hit.view.id;
      this.stage.hot.edge = hit.zone;
    }
  }

  /** What did this pinch take hold of? */
  pick(h, now) {
    const { stage, editor: ed } = this;
    const m = h.memo;
    const other = this.hands.list.find((o) => o !== h);
    const { rail, belt, bar } = LAY;

    // the brass dial, or anywhere along its rail
    if (Math.abs(m.pc.y - rail.y) < 0.036 && Math.abs(m.pc.x) < rail.halfW + 0.035 && m.pc.z > -0.03 && m.pc.z < 0.075) {
      return this.dialDrag(h);
    }
    // a pill: its ends trim, its body moves
    const hit = stage.pillAt(m.pb, 0.014, 0.06);
    if (hit) {
      const twoHanded = other?.drag?.kind === 'move';
      if (hit.zone !== 'body' && !twoHanded) return this.trimDrag(h, hit.view, hit.zone);
      return this.moveDrag(h, ed.beginMove(hit.view.id), hit.view, m.pb);
    }
    // a recording on the shelf
    if (m.pl.z > -0.04 && m.pl.z < 0.07) {
      const tile = stage.tileAt(m.pl, 0.012);
      if (tile?.import) {
        sfx('press');
        this.app.importVideos();
        return null;
      }
      if (tile?.src) {
        const handle = ed.beginAdd(tile.src.id);
        if (handle) {
          const view = stage.viewFor(handle.clip);
          view.lenM = clipLen(handle.clip) * stage.mPerFrame;
          view.group.position.copy(m.pb);
          return this.moveDrag(h, handle, view, m.pb, true);
        }
      }
    }
    // the belt can be dragged with a pinch too
    if (Math.abs(m.pc.y - belt.y) < belt.halfH + 0.015 && Math.abs(m.pc.x) < belt.halfW + 0.02 && m.pc.z > -0.03 && m.pc.z < belt.top + 0.05) {
      return this.beltDrag(h);
    }
    // the desk bar
    if (Math.abs(m.pc.y - bar.y) < 0.035 && Math.abs(m.pc.x) < bar.halfW + 0.03 && m.pc.z > -0.03 && m.pc.z < 0.07) {
      return this.deskDrag(h);
    }
    // a pinch on a key presses it
    for (const b of stage.buttons) {
      if (b.pinchHit(h.pinch)) {
        b.fire(h.side, now);
        return null;
      }
    }
    return null;
  }

  snap(want, len, id) {
    const { stage, editor: ed } = this;
    const tol = 0.012 / stage.mPerFrame;
    const marks = snapFrames(ed.project, id);
    marks.push(Math.round(ed.time));
    let best = null;
    let bd = tol;
    for (const f of marks) {
      const d0 = Math.abs(want - f);
      if (d0 < bd) {
        bd = d0;
        best = f;
      }
      const d1 = Math.abs(want + len - f);
      if (d1 < bd) {
        bd = d1;
        best = f - len;
      }
    }
    const key = best == null ? null : Math.round(best);
    if (key !== this.snapKey) {
      this.snapKey = key;
      if (key != null) sfx('snap', { rate: 70 });
    }
    return Math.max(0, Math.round(best == null ? want : best));
  }

  moveDrag(h, handle, view, grabPoint, fromShelf = false) {
    if (!handle) return null;
    const { stage, editor: ed } = this;
    const self = this;
    const off = fromShelf ? V() : V().copy(view.group.position).sub(grabPoint);
    off.z = 0;
    view.held = true;
    view.setClipped(false);
    view.heldPos.copy(grabPoint).add(off);
    view.squashV = 4;
    sfx('grab');
    const drag = {
      kind: 'move',
      id: handle.clip.id,
      handle,
      view,
      lane: -1,
      at: 0,
      move(hand) {
        const p = hand.memo.pb;
        view.heldPos.copy(p).add(off);
        view.heldPos.z = Math.max(p.z, 0.012);
        const pair = self.pairOf(drag);
        if (pair) {
          handle.clearPreview();
          drag.lane = -1;
          return;
        }
        const lane = stage.laneAt(view.heldPos.y, p.z);
        const inWindow = Math.abs(view.heldPos.x) < LAY.halfW + view.lenM / 2;
        if (lane >= 0 && inWindow) {
          const want = ed.time + (view.heldPos.x - view.lenM / 2) / stage.mPerFrame;
          const at = self.snap(want, clipLen(handle.clip), handle.clip.id);
          const spot = handle.preview(lane, at);
          if (drag.lane !== lane || drag.slot !== spot.index) sfx('tick', { rate: 60 });
          drag.lane = lane;
          drag.slot = spot.index;
          drag.at = at;
        } else {
          handle.clearPreview();
          drag.lane = -1;
        }
      },
      end() {
        view.held = false;
        view.setClipped(true);
        if (drag.lane >= 0) handle.commit(drag.lane, drag.at);
        else handle.cancel();
        self.snapKey = null;
      },
      cancel() {
        view.held = false;
        view.setClipped(true);
        handle.cancel();
      },
    };
    return drag;
  }

  trimDrag(h, view, edge) {
    const { stage, editor: ed } = this;
    const t = ed.beginTrim(view.id, edge);
    if (!t) return null;
    const x0 = h.memo.pb.x;
    let last = 0;
    let lastLimit = '';
    sfx('grab');
    return {
      kind: 'trim',
      id: view.id,
      move(hand) {
        stage.hot.id = view.id;
        stage.hot.edge = edge;
        const d = Math.round((hand.memo.pb.x - x0) / stage.mPerFrame);
        if (d === last) return;
        last = d;
        const info = t.update(d);
        if (info.limit) {
          if (info.limit !== lastLimit) sfx('limit');
        } else sfx('ratchet', { rate: 55 });
        lastLimit = info.limit;
      },
      end() {
        t.commit();
      },
      cancel() {
        t.cancel();
      },
    };
  }

  dialDrag(h) {
    const { editor: ed } = this;
    ed.stop();
    this.beltVel = 0;
    const set = (hand) => {
      const f = clamp((hand.memo.pc.x + LAY.rail.halfW) / (LAY.rail.halfW * 2), 0, 1) * ed.duration();
      const before = Math.round(ed.time);
      ed.seek(f);
      if (Math.round(ed.time) !== before) sfx('tick', { rate: 45 });
    };
    set(h);
    sfx('grab');
    return { kind: 'dial', move: set, end: () => ed.persist(), cancel() {} };
  }

  beltDrag(h) {
    const { stage, editor: ed } = this;
    ed.stop();
    this.beltVel = 0;
    let lastX = h.memo.pc.x;
    let vel = 0;
    const self = this;
    sfx('grab');
    return {
      kind: 'belt',
      move(hand, dt) {
        const dx = hand.memo.pc.x - lastX;
        lastX = hand.memo.pc.x;
        vel = vel * 0.6 + (dx / Math.max(0.004, dt || 0.011)) * 0.4;
        ed.seek(ed.time - dx / stage.mPerFrame, { fine: true });
      },
      end() {
        if (Math.abs(vel) > 0.1) self.beltVel = clamp(vel, -2.5, 2.5);
        else ed.seek(ed.time);
      },
      cancel() {
        ed.seek(ed.time);
      },
    };
  }

  deskDrag(h) {
    const { stage } = this;
    const last = V().copy(h.pinchWorld);
    sfx('grab');
    return {
      kind: 'desk',
      move(hand) {
        _a.copy(hand.pinchWorld).sub(last);
        last.copy(hand.pinchWorld);
        stage.rig.position.add(_a);
      },
      end: () => {
        sfx('drop');
        this.app.deskMoved();
      },
      cancel() {},
    };
  }

  pairOf(drag) {
    const [l, r] = this.hands.list;
    const a = l.drag;
    const b = r.drag;
    if (a?.kind === 'move' && b?.kind === 'move' && a.id !== b.id && (a === drag || b === drag)) return a === drag ? b : a;
    return null;
  }

  /** Two pills, one in each hand, held end to end for two seconds. */
  updateMerge(dt, now) {
    const { stage, editor: ed } = this;
    const [lh, rh] = this.hands.list;
    const a = lh.drag;
    const b = rh.drag;
    if (!(a?.kind === 'move' && b?.kind === 'move' && a.id !== b.id)) {
      if (stage.mergeFx) {
        stage.mergeFx = null;
        chargeTone(null);
      }
      this.merge = 0;
      return;
    }
    const L = a.view.heldPos.x <= b.view.heldPos.x ? a : b;
    const R = L === a ? b : a;
    const gap = R.view.heldPos.x - R.view.lenM / 2 - (L.view.heldPos.x + L.view.lenM / 2);
    const dy = Math.abs(L.view.heldPos.y - R.view.heldPos.y);
    const dz = Math.abs(L.view.heldPos.z - R.view.heldPos.z);
    const overlapLimit = Math.min(L.view.lenM, R.view.lenM) * 0.85 + 0.02;
    const touching = gap < 0.024 && gap > -overlapLimit && dy < 0.05 && dz < 0.07;
    const was = this.merge;
    this.merge = touching ? this.merge + dt / 2 : Math.max(0, this.merge - dt * 2.5);
    if (touching && was === 0) sfx('snap');
    const point = (stage.mergeFx?.point || V()).set(
      (L.view.heldPos.x + L.view.lenM / 2 + R.view.heldPos.x - R.view.lenM / 2) / 2,
      (L.view.heldPos.y + R.view.heldPos.y) / 2,
      (L.view.heldPos.z + R.view.heldPos.z) / 2,
    );
    stage.mergeFx = { progress: clamp(this.merge, 0, 1), point };
    chargeTone(this.merge > 0 ? clamp(this.merge, 0.02, 1) : null);
    if (this.merge >= 1) {
      for (const d of [L, R]) {
        d.view.held = false;
        d.view.setClipped(true);
      }
      lh.drag = rh.drag = null;
      lh.mute = rh.mute = true;
      this.merge = 0;
      chargeTone(null);
      stage.mergeFx = null;
      ed.mergeHeld(L.handle, R.handle);
      stage.mergeBurst(point);
    }
  }

  // ---- fingertip swipes ----------------------------------------------------

  /** The belt: a fingertip on it drags the film; a flick keeps it rolling. */
  beltFinger(h, free, dt, now) {
    const { stage, editor: ed } = this;
    const m = h.memo;
    const { belt } = LAY;
    const tc = m.tc;
    const skin = tc.z - h.tipRadius - belt.top;
    const on = free && Math.abs(tc.x) < belt.halfW + 0.025 && Math.abs(tc.y - belt.y) < belt.halfH + 0.01 && skin < 0.009 && skin > -0.05;
    if (!on) {
      if (m.belt) this.endBelt(h);
      return;
    }
    if (!m.belt) {
      m.belt = { x0: tc.x, last: tc.x, vel: 0, moving: false };
      this.beltVel = 0;
      return;
    }
    const s = m.belt;
    const dx = tc.x - s.last;
    s.last = tc.x;
    if (!s.moving) {
      if (Math.abs(tc.x - s.x0) < 0.006) return; // a resting finger does nothing
      s.moving = true;
      ed.stop();
      this.beltTouch = h;
    }
    s.vel = s.vel * 0.6 + (dx / Math.max(0.004, dt)) * 0.4;
    const before = Math.round(ed.time);
    ed.seek(ed.time - dx / stage.mPerFrame, { fine: true });
    if (Math.round(ed.time) !== before) sfx('tick', { rate: 70 });
  }
  endBelt(h) {
    const s = h.memo.belt;
    h.memo.belt = null;
    if (this.beltTouch === h) this.beltTouch = null;
    if (!s || !s.moving) return;
    if (Math.abs(s.vel) > 0.12) this.beltVel = clamp(s.vel, -2.5, 2.5);
    else this.editor.seek(this.editor.time);
  }
  coast(dt) {
    if (!this.beltVel) return;
    const ed = this.editor;
    if (ed.playing) {
      this.beltVel = 0;
      return;
    }
    ed.seek(ed.time - (this.beltVel * dt) / this.stage.mPerFrame, { fine: true });
    this.beltVel *= Math.exp(-dt * 2.4);
    if (Math.abs(this.beltVel) < 0.02 || ed.time <= 0 || ed.time >= ed.duration()) {
      this.beltVel = 0;
      ed.seek(ed.time);
      ed.persist();
    }
  }

  /** The library: swipe up and down anywhere on it; a tap adds the recording. */
  libFinger(h, free, dt, now) {
    const { stage, editor: ed } = this;
    const m = h.memo;
    const { tileW, pitch, rows } = LAY.lib;
    const tl = m.tl;
    const skin = tl.z - h.tipRadius - 0.008;
    const on = free && Math.abs(tl.x) < tileW / 2 + 0.02 && Math.abs(tl.y) < (rows * pitch) / 2 + 0.02 && skin < 0.008 && skin > -0.06;
    if (!on) {
      const s = m.lib;
      if (s) {
        m.lib = null;
        stage.libTouching = false;
        if (s.moving) stage.libVel = clamp(s.vel, -9, 9);
        else if (now - s.t0 < 900 && free && skin >= 0.008 && s.tile) {
          // finger came back out the front without sliding: that was a tap
          s.tile.press = 1;
          if (s.tile.import) {
            sfx('press');
            this.app.importVideos();
          } else ed.appendSource(s.tile.src.id);
        }
      }
      return;
    }
    if (!m.lib) {
      m.lib = { y0: tl.y, last: tl.y, vel: 0, moving: false, t0: now, tile: stage.tileAt(tl, 0.006) };
      stage.libVel = 0;
      stage.libTouching = true;
      if (m.lib.tile) m.lib.tile.press = 0.6;
      return;
    }
    const s = m.lib;
    const dy = tl.y - s.last;
    s.last = tl.y;
    if (!s.moving && Math.abs(tl.y - s.y0) > 0.012) s.moving = true;
    if (s.moving) {
      const rowsMoved = dy / pitch;
      const max = stage.maxLibScroll();
      const over = stage.libScroll < 0 || stage.libScroll > max;
      stage.libScroll += rowsMoved * (over ? 0.4 : 1);
      s.vel = s.vel * 0.6 + (rowsMoved / Math.max(0.004, dt)) * 0.4;
    } else if (s.tile) s.tile.press = Math.max(s.tile.press, 0.6);
  }

  /** A fingertip on a pill selects it. */
  tapPills(h, dt, now) {
    const { stage, editor: ed } = this;
    const m = h.memo;
    const tb = m.tb;
    const depth = tb.z - h.tipRadius;
    let id = null;
    if (depth < LAY.D + 0.007 && depth > -0.045) {
      const hit = stage.pillAt(tb, 0.004, 0.08);
      if (hit) id = hit.view.id;
    }
    const vy = m.tbPrev ? (tb.y - m.tbPrev.y) / Math.max(0.004, dt) : 0;
    (m.tbPrev ||= V()).copy(tb);
    if (id && id !== m.touching) {
      const chopping = h.extended >= 3 && vy < -0.5;
      if (!chopping && h.speed < 1.2 && id !== ed.project.selected) ed.select(id);
    }
    m.touching = id;
  }

  /**
   * The cut. The little-finger edge of an open hand, travelling down through
   * the selected pill. Only the selected pill can be cut and the cut always
   * lands on the line, however much the hand shakes.
   */
  chop(h, free, dt, now) {
    const { stage, editor: ed } = this;
    const m = h.memo;
    const pts = (m.blade ||= h.blade.map(() => ({ p: V(), prev: V(), top: -9, topAt: 0 })));
    const fresh = !m.bladeOk || !h.hasPrev;
    for (let k = 0; k < pts.length; k++) {
      pts[k].prev.copy(pts[k].p);
      pts[k].p.copy(h.blade[k]).applyMatrix4(stage.benchInv);
      if (fresh) {
        pts[k].prev.copy(pts[k].p);
        pts[k].top = pts[k].p.y;
        pts[k].topAt = now;
      }
      // highest point of this stroke: where the hand was before it came down
      if (pts[k].p.y >= pts[k].top || now - pts[k].topAt > 420) {
        pts[k].top = pts[k].p.y;
        pts[k].topAt = now;
      }
    }
    m.bladeOk = true;
    if (!free || fresh) return 0;
    _n.copy(h.palmNormal).transformDirection(stage.benchInv);
    const edgeOn = Math.abs(_n.y) < 0.84;
    const shaped = h.extended >= 3 && edgeOn;

    // show the blade as ready while an open hand hovers above the selected pill
    let armed = 0;
    const sel = stage.pills.get(ed.project.selected);
    if (sel && shaped && !ed.cutBlocker()) {
      const p = pts[1].p;
      if (p.y > sel.y && p.y < sel.y + 0.3 && Math.abs(p.z) < 0.12 && p.x > sel.x - sel.lenM / 2 - 0.03 && p.x < sel.x + sel.lenM / 2 + 0.03) armed = 1;
    }
    if (!shaped || now < this.chopAfter) return armed;

    for (let k = 0; k < pts.length; k++) {
      const a = pts[k].prev;
      const b = pts[k].p;
      for (let t = 0; t < 3; t++) {
        const ly = laneY(t);
        if (!(a.y > ly && b.y <= ly)) continue;
        const u = (a.y - ly) / (a.y - b.y);
        const cx = a.x + (b.x - a.x) * u;
        const cz = a.z + (b.z - a.z) * u;
        const vy = (a.y - b.y) / Math.max(0.004, dt);
        if (vy < 0.45 || Math.abs(cz - 0.004) > 0.055) continue;
        if (pts[k].top < ly + LAY.R + 0.012) continue; // the stroke must start above the pill
        const view = stage.pillOnLane(t, cx, 0.012);
        if (!view) continue;
        this.chopAfter = now + 450;
        if (view.id !== ed.project.selected) {
          ed.emit('denied', { reason: 'select', id: view.id });
          return 0;
        }
        if (now - ed.selectedAt < 200) return 0; // the same stroke that selected it
        ed.cutSelected();
        return 0;
      }
    }
    return armed;
  }

  // ---- mouse (computer preview) --------------------------------------------

  castMouse(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
    this.ray.setFromCamera(this.ndc, this.camera);
    const { stage } = this;
    const m = this.mouse.memo;
    // where the pointer meets the bench, console and library planes
    const onPlane = (group, inv, out, z) => {
      group.updateWorldMatrix(true, false);
      const origin = _a.copy(this.ray.ray.origin);
      const dir = _n.copy(this.ray.ray.direction);
      const toLocal = new THREE.Matrix4().copy(group.matrixWorld).invert();
      origin.applyMatrix4(toLocal);
      dir.transformDirection(toLocal);
      const t = Math.abs(dir.z) > 1e-5 ? (z - origin.z) / dir.z : -1;
      if (t > 0) out.copy(origin).addScaledVector(dir, t);
      return t > 0;
    };
    onPlane(stage.bench, null, m.pb, 0.008);
    onPlane(stage.console, null, m.pc, 0.012);
    onPlane(stage.lib, null, m.pl, 0.01);
    const hits = this.ray.intersectObject(stage.rig, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && !o.userData.pick) o = o.parent;
      if (!o || !hit.object.visible) continue;
      let vis = true;
      for (let q = hit.object; q; q = q.parent) if (!q.visible) vis = false;
      if (vis) return o.userData.pick;
    }
    return null;
  }

  bindMouse() {
    const c = this.canvas;
    const mouse = this.mouse;
    const { stage, editor: ed } = this;
    c.addEventListener('pointerdown', (e) => {
      if (this.app.inXR() || e.button !== 0) return;
      this.app.gesture();
      const pick = this.castMouse(e);
      mouse.down = { pick, x: e.clientX, y: e.clientY, moved: false };
      c.setPointerCapture(e.pointerId);
      if (!pick) return;
      if (pick.type === 'button') pick.ref.fire('mouse');
      else if (pick.type === 'pill') ed.select(pick.id);
      else if (pick.type === 'dial' || pick.type === 'rail') mouse.drag = this.dialDrag(mouse);
      else if (pick.type === 'belt') mouse.drag = this.beltDrag(mouse);
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.app.inXR()) return;
      const pick = this.castMouse(e);
      const d = mouse.down;
      if (!d) {
        c.style.cursor = pick ? (pick.type === 'button' ? 'pointer' : 'grab') : 'default';
        if (pick?.type === 'pill' && pick.edge) {
          stage.hot.id = pick.id;
          stage.hot.edge = pick.edge;
        }
        return;
      }
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) {
        d.moved = true;
        const p = d.pick;
        if (p?.type === 'pill' && !mouse.drag) {
          const view = stage.pills.get(p.id);
          const hit = view && stage.pillAt(mouse.memo.pb, 0.02, 0.2);
          const zone = p.edge || (hit && hit.view === view ? hit.zone : 'body');
          if (view) mouse.drag = zone === 'body' ? this.moveDrag(mouse, ed.beginMove(p.id), view, mouse.memo.pb) : this.trimDrag(mouse, view, zone);
        } else if (p?.type === 'tile' && !mouse.drag) {
          const tile = stage.tiles.find((t) => t.key === p.key);
          if (tile?.src) {
            const handle = ed.beginAdd(tile.src.id);
            if (handle) {
              const view = stage.viewFor(handle.clip);
              view.lenM = clipLen(handle.clip) * stage.mPerFrame;
              view.group.position.copy(mouse.memo.pb);
              mouse.drag = this.moveDrag(mouse, handle, view, mouse.memo.pb, true);
            }
          }
        }
      }
      if (mouse.drag) {
        mouse.drag.move(mouse, 0.016, performance.now());
        c.style.cursor = 'grabbing';
      }
    });
    const up = (e, cancel) => {
      if (this.app.inXR()) return;
      const d = mouse.down;
      mouse.down = null;
      if (mouse.drag) {
        if (cancel) mouse.drag.cancel();
        else mouse.drag.end(mouse);
        mouse.drag = null;
      } else if (d && !d.moved && d.pick?.type === 'tile') {
        const tile = stage.tiles.find((t) => t.key === d.pick.key);
        if (tile) {
          tile.press = 1;
          if (tile.import) this.app.importVideos();
          else ed.appendSource(tile.src.id);
        }
      }
      if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', (e) => up(e, false));
    c.addEventListener('pointercancel', (e) => up(e, true));
    c.addEventListener('dblclick', (e) => {
      if (this.app.inXR()) return;
      const pick = this.castMouse(e);
      if (pick?.type === 'pill') {
        ed.select(pick.id);
        ed.cutSelected();
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (this.app.inXR()) return;
        e.preventDefault();
        const pick = this.castMouse(e);
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (pick?.type === 'tile') {
          stage.libScroll = clamp(stage.libScroll + delta * 0.004, 0, stage.maxLibScroll());
        } else {
          ed.stop();
          ed.seek(ed.time + (delta * 0.0006) / stage.mPerFrame);
        }
      },
      { passive: false },
    );
  }
}

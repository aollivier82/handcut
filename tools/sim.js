// Simulated hands for checking gestures on a computer: drives the same
// HandState objects the headset fills in, through the real interaction code.
// Usage in the page console:  const sim = await import('/tools/sim.js'); await sim.runAll()

import * as THREE from 'three';
import { LAY, laneY } from '/src/stage.js';
import { clipLen, clipEnd, FPS } from '/src/model.js';

const H = window.__handcut;
const { stage, editor: ed, hands, interact } = H;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
let frame = 0;
const waiters = [];
const script = { left: null, right: null };

function setHand(h, s) {
  // s: { pos (workspace), pinch, open, normal (workspace) }
  const was = h.pinching;
  h.tracked = true;
  h.lostFor = 0;
  h.tipPrev.copy(h.tip);
  h.hasPrev = !!h.memo.simSeen;
  h.memo.simSeen = true;
  h.tip.copy(s.pos);
  h.tipRadius = 0.008;
  h.pinch.copy(s.pos);
  h.pinchWorld.copy(s.pos).applyMatrix4(stage.rig.matrixWorld);
  h.pinching = !!s.pinch;
  h.pinchStarted = h.pinching && !was;
  h.pinchEnded = !h.pinching && was;
  h.extended = s.open ? 4 : 1;
  h.open = !!s.open;
  h.speed = 0.2;
  h.palmNormal.copy(s.normal || V(0, 1, 0));
  for (let k = 0; k < h.blade.length; k++) h.blade[k].copy(s.pos).add(V(0, k * 0.012, 0));
}
function clearHand(h) {
  const was = h.pinching;
  h.tracked = false;
  h.lostFor = 9999;
  h.pinching = false;
  h.pinchStarted = false;
  h.pinchEnded = was;
  h.hasPrev = false;
  h.memo.simSeen = false;
}

if (!interact.__sim) {
  const orig = interact.update.bind(interact);
  interact.update = (dt, now, inXR) => {
    frame++;
    let active = false;
    for (const h of hands.list) {
      const s = script[h.side];
      if (s) {
        active = true;
        setHand(h, s);
      } else if (h.memo.simSeen) {
        clearHand(h);
        active = true;
      }
    }
    const out = orig(dt, now, active || inXR);
    for (const h of hands.list) if (!script[h.side] && !h.memo.simSeen && h.drag) { h.drag.cancel(); h.drag = null; }
    while (waiters.length && waiters[0].at <= frame) waiters.shift().go();
    return out;
  };
  interact.__sim = true;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const frames = (n = 1) => new Promise((go) => waiters.push({ at: frame + n, go }) && waiters.sort((a, b) => a.at - b.at));

const benchPt = (x, y, z) => V(x, y, z).applyMatrix4(stage.bench.matrix);
const consolePt = (x, y, z) => V(x, y, z).applyMatrix4(stage.console.matrix);
const libPt = (x, y, z) => V(x, y, z).applyMatrix4(stage.lib.matrix);
const buttonPt = (b, x, y, z) => V(x, y, z).applyMatrix4(b.inv.clone().invert());
const benchDir = (x, y, z) => V(x, y, z).transformDirection(stage.bench.matrix);

/** Move a hand from a to b over n frames. */
export async function glide(side, a, b, n, state = {}) {
  for (let i = 0; i <= n; i++) {
    script[side] = { pos: a.clone().lerp(b, i / n), ...state };
    await frames(1);
  }
}
export async function hold(side, p, n, state = {}) {
  script[side] = { pos: p.clone(), ...state };
  await frames(n);
}
export function drop(side) {
  script[side] = null;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  return ok;
}
const lane = (t) => ed.project.tracks[t];
const spans = (t) => lane(t).map((c) => [c.at, clipEnd(c)].join('-')).join(' ');

async function reset() {
  drop('left');
  drop('right');
  await frames(3);
  ed.stop();
  ed.starter();
  ed.undoStack.length = ed.redoStack.length = 0;
  ed.project.selected = null;
  ed.zoomIndex = 3;
  ed.time = 60;
  ed.revision++;
  interact.beltVel = 0;
  await frames(4);
}

export async function tPress() {
  await reset();
  const b = stage.playBtn;
  await glide('right', buttonPt(b, 0, 0, 0.09), buttonPt(b, 0, 0, 0.014), 10);
  await frames(2);
  const on = ed.playing;
  await glide('right', buttonPt(b, 0, 0, 0.014), buttonPt(b, 0, 0, 0.09), 8);
  // a diagonal, fast poke on a rack key
  ed.stop();
  const k = stage.keys.ratio;
  const before = ed.project.ratio;
  await glide('right', buttonPt(k, 0.05, 0.02, 0.07), buttonPt(k, 0.004, 0, 0.012), 3);
  await frames(2);
  const flipped = ed.project.ratio !== before;
  await glide('right', buttonPt(k, 0.004, 0, 0.012), buttonPt(k, 0, 0, 0.09), 6);
  // sweeping sideways through keys at depth must not press them
  const r0 = ed.project.ratio;
  const u0 = ed.undoStack.length;
  await glide('right', buttonPt(k, -0.2, 0, 0.012), buttonPt(k, 0.2, 0, 0.012), 14);
  drop('right');
  await frames(2);
  check('fingertip presses Play', on);
  check('fast diagonal poke presses a rack key', flipped, before + ' -> ' + ed.project.ratio);
  check('sideways sweep through keys presses nothing', ed.project.ratio === r0 && ed.undoStack.length === u0, 'undo ' + u0 + ' -> ' + ed.undoStack.length);
}

export async function tSelect() {
  await reset();
  const c = lane(0)[1];
  const v = stage.pills.get(c.id);
  await glide('right', benchPt(v.x, v.y, 0.1), benchPt(v.x, v.y, 0.016), 12);
  await frames(2);
  const ok = ed.project.selected === c.id;
  await glide('right', benchPt(v.x, v.y, 0.016), benchPt(v.x, v.y, 0.1), 6);
  drop('right');
  check('fingertip tap selects a pill', ok, ed.project.selected + ' vs ' + c.id);
}

export async function tBelt() {
  await reset();
  const z = LAY.belt.top + 0.008 + 0.003;
  const t0 = ed.time;
  await glide('right', consolePt(0.1, LAY.belt.y, 0.08), consolePt(0.1, LAY.belt.y, z), 6);
  await glide('right', consolePt(0.1, LAY.belt.y, z), consolePt(-0.05, LAY.belt.y, z), 20);
  const dragged = ed.time - t0;
  await glide('right', consolePt(-0.05, LAY.belt.y, z), consolePt(-0.06, LAY.belt.y, 0.09), 4);
  drop('right');
  await frames(90);
  const expect = 0.15 / stage.mPerFrame;
  check('belt swipe scrolls the film 1:1', Math.abs(dragged - expect) < expect * 0.12, dragged.toFixed(1) + ' frames, expected ~' + expect.toFixed(1));
  check('a flick keeps rolling, then settles on a whole frame', ed.time > t0 + dragged + 1 && Number.isInteger(ed.time), 'time ' + ed.time);
}

export async function tChop() {
  await reset();
  const n0 = lane(0).length;
  const y = laneY(0);
  const chop = async (side) => {
    const st = { open: true, normal: benchDir(1, 0, 0) };
    await hold(side, benchPt(0.004, y + 0.14, 0.004), 3, st);
    await glide(side, benchPt(0.004, y + 0.14, 0.004), benchPt(0.01, y - 0.1, 0.006), 7, st);
    drop(side);
    await frames(3);
  };
  // nothing selected: the chop must be refused
  await chop('right');
  const refused = lane(0).length === n0;
  // select the pill under the line, then chop
  const c = lane(0).find((k) => k.at < ed.time && clipEnd(k) > ed.time);
  ed.select(c.id);
  await sleep(650);
  const at = Math.round(ed.time);
  await chop('right');
  const cut = lane(0).length === n0 + 1 && lane(0).some((k) => k.at === at);
  // shaky: off the line by 3 cm, the cut still lands on the line
  ed.seek(ed.time + 30);
  const c2 = lane(0).find((k) => k.at < ed.time && clipEnd(k) > ed.time);
  ed.select(c2.id);
  await sleep(650);
  const at2 = Math.round(ed.time);
  const st = { open: true, normal: benchDir(1, 0, 0) };
  await hold('left', benchPt(0.03, y + 0.14, 0.01), 3, st);
  await glide('left', benchPt(0.03, y + 0.14, 0.01), benchPt(-0.02, y - 0.1, 0.0), 7, st);
  drop('left');
  await frames(3);
  const cut2 = lane(0).length === n0 + 2 && lane(0).some((k) => k.at === at2);
  // flat palm coming down (reaching, not chopping) must not cut
  ed.seek(ed.time + 20);
  const c3 = lane(0).find((k) => k.at < ed.time && clipEnd(k) > ed.time);
  ed.select(c3.id);
  await sleep(650);
  const flat = { open: true, normal: benchDir(0, 1, 0) };
  await hold('right', benchPt(0, y + 0.14, 0.004), 3, flat);
  await glide('right', benchPt(0, y + 0.14, 0.004), benchPt(0, y - 0.1, 0.004), 7, flat);
  drop('right');
  await frames(3);
  const noFlat = lane(0).length === n0 + 2;
  // slow hand passing down in front of the bench (reaching for the console) must not cut
  await sleep(600);
  await hold('right', benchPt(0, y + 0.14, 0.11), 3, st);
  await glide('right', benchPt(0, y + 0.14, 0.11), benchPt(0, y - 0.1, 0.11), 7, st);
  drop('right');
  await frames(3);
  const noReach = lane(0).length === n0 + 2;
  check('chop on an unselected pill is refused', refused);
  check('chop cuts the selected pill at the line', cut, spans(0));
  check('a shaky, off-line chop still cuts exactly on the line', cut2, spans(0));
  check('a flat palm coming down does not cut', noFlat, spans(0));
  check('a hand passing in front of the bench does not cut', noReach, spans(0));
}

export async function tTrim() {
  await reset();
  const [a, b] = lane(0);
  const lenA = clipLen(a);
  const bAt = b.at;
  let v = stage.pills.get(a.id);
  const x1 = v.x + v.lenM / 2;
  const p0 = benchPt(x1 - 0.006, v.y, 0.012);
  await hold('right', p0, 3);
  await hold('right', p0, 2, { pinch: true });
  await glide('right', p0, benchPt(x1 - 0.006 + 0.045, v.y, 0.012), 14, { pinch: true });
  const liveEdge = stage.pills.get(a.id);
  const followed = Math.abs(liveEdge.x + liveEdge.lenM / 2 - (x1 + 0.045)) < 0.004;
  await hold('right', benchPt(x1 - 0.006 + 0.045, v.y, 0.012), 2);
  drop('right');
  await frames(3);
  const a2 = lane(0)[0];
  const grew = clipLen(a2) - lenA;
  check('right handle follows the hand', followed);
  check('right handle: +4.5 cm adds 30 frames, left edge fixed, neighbour pushed', grew === 30 && a2.at === 0 && lane(0)[1].at === bAt + 30, 'grew ' + grew + ' | ' + spans(0));

  // left handle of the second pill (attached to the first): right edge must stay put on screen
  await sleep(700); // let the pushed pill finish easing into place
  const b2 = lane(0)[1];
  v = stage.pills.get(b2.id);
  const rightEdge = v.x + v.lenM / 2;
  const x0 = v.x - v.lenM / 2;
  const outBefore = b2.segs[0].out;
  const q0 = benchPt(x0 + 0.006, v.y, 0.012);
  await hold('left', q0, 3);
  await hold('left', q0, 2, { pinch: true });
  let maxDrift = 0;
  for (let i = 0; i <= 14; i++) {
    script.left = { pos: q0.clone().lerp(benchPt(x0 + 0.006 + 0.03, v.y, 0.012), i / 14), pinch: true };
    await frames(1);
    const w = stage.pills.get(b2.id);
    maxDrift = Math.max(maxDrift, Math.abs(w.x + w.lenM / 2 - rightEdge));
  }
  drop('left');
  await frames(3);
  const b3 = lane(0)[1];
  check('left handle: the right end does not move on screen', maxDrift < 0.0012, 'max drift ' + (maxDrift * 1000).toFixed(2) + ' mm');
  check('left handle: out point unchanged, 20 frames trimmed, no gap', b3.segs[0].out === outBefore && clipLen(b3) === clipLen(b2) && b3.at === clipEnd(lane(0)[0]), spans(0) + ' in=' + b3.segs[0].in);

  // pull far past the end of the footage: stops, and says why
  await sleep(700);
  v = stage.pills.get(a.id);
  const e1 = v.x + v.lenM / 2;
  const r0 = benchPt(e1 - 0.006, v.y, 0.012);
  await hold('right', r0, 2);
  await hold('right', r0, 2, { pinch: true });
  await glide('right', r0, benchPt(e1 + 0.4, v.y, 0.012), 10, { pinch: true });
  const limit = ed.trim?.limit;
  const hint = stage.hint.text;
  drop('right');
  await frames(3);
  check('end of footage stops the handle and says why', limit === 'end' && /end of the recording/i.test(hint), limit + ' | ' + hint);
}

export async function tMove() {
  await reset();
  const [a, b] = lane(0);
  const v = stage.pills.get(b.id);
  const p0 = benchPt(v.x, v.y, 0.012);
  await hold('right', p0, 3);
  await hold('right', p0, 2, { pinch: true });
  await glide('right', p0, benchPt(v.x - 0.1, laneY(1), 0.03), 14, { pinch: true });
  const ghost = stage.ghost.visible;
  await hold('right', benchPt(v.x - 0.1, laneY(1), 0.03), 2); // open the fingers
  drop('right');
  await frames(4);
  check('carried pill shows where it will land', ghost);
  check('pill moves to track 2', lane(1).length === 1 && lane(0).length === 1, spans(0) + ' | ' + spans(1));
  // reorder: first pill of a packed pair dropped after the second
  await reset();
  const [c, d] = lane(0);
  const vc = stage.pills.get(c.id);
  const vd = stage.pills.get(d.id);
  const g0 = benchPt(vc.x, vc.y, 0.012);
  await hold('left', g0, 3);
  await hold('left', g0, 2, { pinch: true });
  const endX = vd.x + vd.lenM / 2; // right end of the second pill before the lift
  const g1 = benchPt(endX - vc.lenM + vc.lenM / 2 + 0.004, vc.y, 0.03);
  await glide('left', g0, g1, 16, { pinch: true });
  await hold('left', g1, 2);
  drop('left');
  await frames(4);
  const order = lane(0).map((k) => k.segs[0].src).join(',');
  check('reorder: no hole is left behind and the pill snaps on', order === 's-fractal,s-aurora' && lane(0)[0].at === 0 && lane(0)[1].at === clipEnd(lane(0)[0]), order + ' ' + spans(0));
  ed.undo();
  await frames(2);
  {
    const k = lane(0)[1];
    const vk = stage.pills.get(k.id);
    const h0 = benchPt(vk.x, vk.y, 0.012);
    await hold('right', h0, 2);
    await hold('right', h0, 2, { pinch: true });
    await glide('right', h0, benchPt(vk.x, laneY(2), 0.03), 8, { pinch: true });
    drop('right'); // the hand vanishes mid-carry
    await frames(4);
    check('tracking lost while carrying puts the pill back', lane(0).length === 2 && lane(2).length === 0 && ed.held.size === 0, spans(0) + ' | ' + spans(2));
  }
  check('undo restores the order', lane(0).map((k) => k.segs[0].src).join(',') === 's-aurora,s-fractal', spans(0));
}

export async function tMerge() {
  await reset();
  // cut the first pill, then pick up both halves and hold them together
  const c = lane(0)[0];
  ed.select(c.id);
  ed.cutSelected();
  await frames(6);
  const [a, b] = lane(0);
  const va = stage.pills.get(a.id);
  const vb = stage.pills.get(b.id);
  const pa = benchPt(va.x, va.y, 0.012);
  const pb = benchPt(vb.x, vb.y, 0.012);
  await hold('left', pa, 2);
  await hold('right', pb, 2);
  script.left = { pos: pa.clone(), pinch: true };
  script.right = { pos: pb.clone(), pinch: true };
  await frames(3);
  // lift both, pull them apart, then bring them end to end
  const apartA = benchPt(va.x - 0.06, va.y + 0.03, 0.06);
  const apartB = benchPt(vb.x + 0.06, vb.y + 0.03, 0.06);
  for (let i = 0; i <= 10; i++) {
    script.left = { pos: pa.clone().lerp(apartA, i / 10), pinch: true };
    script.right = { pos: pb.clone().lerp(apartB, i / 10), pinch: true };
    await frames(1);
  }
  const noEarly = ed.held.size === 2 && !stage.mergeFx?.progress;
  const togetherA = benchPt(-va.lenM / 2 - 0.004, va.y + 0.03, 0.06);
  const togetherB = benchPt(vb.lenM / 2 + 0.004, vb.y + 0.03, 0.06);
  for (let i = 0; i <= 10; i++) {
    script.left = { pos: apartA.clone().lerp(togetherA, i / 10), pinch: true };
    script.right = { pos: apartB.clone().lerp(togetherB, i / 10), pinch: true };
    await frames(1);
  }
  await frames(40);
  const charging = stage.mergeFx ? stage.mergeFx.progress : -1;
  const t0 = performance.now();
  while (ed.held.size && performance.now() - t0 < 4000) await frames(2);
  const took = performance.now() - t0;
  drop('left');
  drop('right');
  await frames(4);
  const m = lane(0)[0];
  check('held apart: no merge starts', noEarly);
  check('held together: the ring fills', charging > 0.1 && charging < 1, 'progress ' + charging.toFixed(2));
  check('after two seconds the halves are one pill again', lane(0).length === 2 && m.segs.length === 1 && m.segs[0].in === 30 && m.segs[0].out === 180, spans(0) + ' segs ' + JSON.stringify(m.segs) + ' after ' + Math.round(took) + ' ms more');
}

export async function tLibrary() {
  await reset();
  const n0 = lane(0).length;
  const t = stage.tiles[2];
  await glide('left', libPt(0, t.y, 0.09), libPt(0, t.y, 0.012), 8);
  await frames(3);
  await glide('left', libPt(0, t.y, 0.012), libPt(0, t.y, 0.09), 8);
  drop('left');
  await frames(4);
  check('tapping a recording adds it to the timeline', lane(0).length === n0 + 1 && lane(0).at(-1).segs[0].src === t.src.id, spans(0));
  // carry one out of the library onto track 3
  const t1 = stage.tiles[0];
  const p0 = libPt(0, t1.y, 0.014);
  await hold('left', p0, 3);
  await hold('left', p0, 2, { pinch: true });
  await glide('left', p0, benchPt(-0.1, laneY(2), 0.03), 18, { pinch: true });
  await hold('left', benchPt(-0.1, laneY(2), 0.03), 2);
  drop('left');
  await frames(4);
  check('a recording carried from the shelf lands on track 3', lane(2).length === 1 && lane(2)[0].segs[0].src === t1.src.id, spans(2));
  // swipe the shelf
  const s0 = stage.libScroll;
  await glide('right', libPt(0, -0.08, 0.09), libPt(0, -0.08, 0.014), 5);
  await glide('right', libPt(0, -0.08, 0.014), libPt(0, 0.06, 0.014), 12);
  const scrolled = stage.libScroll - s0;
  drop('right');
  await frames(30);
  check('swiping the shelf scrolls it without adding anything', scrolled > 0.5 && lane(0).length === n0 + 1, 'scrolled ' + scrolled.toFixed(2) + ' rows');
}

export async function tDial() {
  await reset();
  const p0 = consolePt(stage.dialX(), LAY.rail.y, 0.03);
  await hold('right', p0, 3);
  await hold('right', p0, 2, { pinch: true });
  let ok = true;
  for (let i = 0; i <= 14; i++) {
    const x = stage.dialX() * (1 - i / 14) + 0.1 * (i / 14);
    script.right = { pos: consolePt(x, LAY.rail.y, 0.03), pinch: true };
    await frames(1);
    if (Math.abs(stage.dialX() - x) > 0.004) ok = false; // the dial is under the fingers on every frame
  }
  const want = ((0.1 + LAY.rail.halfW) / (LAY.rail.halfW * 2)) * ed.duration();
  drop('right');
  await frames(3);
  check('the dial follows the pinch while it moves', ok);
  check('dial position maps to the whole edit', Math.abs(ed.time - want) <= 1, ed.time + ' vs ' + want.toFixed(1));
  // the film is centred on the line: the pill under the line is the one at this time
  const c = lane(0).find((k) => k.at <= ed.time && clipEnd(k) > ed.time);
  const v = c && stage.pills.get(c.id);
  check('the film scrolls with the dial: the line sits on the pill at that time', !!v && v.x - v.lenM / 2 <= 0.001 && v.x + v.lenM / 2 >= -0.001, v ? (v.x - v.lenM / 2).toFixed(3) + '..' + (v.x + v.lenM / 2).toFixed(3) : 'no pill');
}

export async function runAll() {
  results.length = 0;
  for (const t of [tPress, tSelect, tBelt, tChop, tTrim, tMove, tMerge, tLibrary, tDial]) {
    try {
      await t();
    } catch (e) {
      check(t.name + ' threw', false, e.stack || e);
    }
  }
  await reset();
  return results;
}
export { results };

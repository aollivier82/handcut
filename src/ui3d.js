// 3D building blocks: glossy materials, text and icon faces, and the
// physical push button every control is made from.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const FONT = '"DM Sans Variable", "DM Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const PX = 4000; // canvas pixels per metre on control faces

export const C = {
  ink: '#1b1d2a',
  cream: 0xf4eee2,
  dark: 0x262a3c,
  darker: 0x171a27,
  orange: 0xff8a3d,
  red: 0xff5d5d,
  mint: 0x57e0c1,
  amber: 0xffc145,
  violet: 0xa98bff,
  blue: 0x6aa9ff,
  white: 0xffffff,
};

// ---- materials -----------------------------------------------------------

function matcapTexture(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  draw(g, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let caps = null;
function matcaps() {
  if (caps) return caps;
  const soft = matcapTexture((g, n) => {
    const r = g.createRadialGradient(n * 0.4, n * 0.34, n * 0.04, n * 0.5, n * 0.5, n * 0.52);
    r.addColorStop(0, '#ffffff');
    r.addColorStop(0.35, '#e9e9ee');
    r.addColorStop(0.75, '#a9abb8');
    r.addColorStop(1, '#6d7083');
    g.fillStyle = r;
    g.fillRect(0, 0, n, n);
    const s = g.createRadialGradient(n * 0.36, n * 0.27, 0, n * 0.36, n * 0.27, n * 0.16);
    s.addColorStop(0, 'rgba(255,255,255,0.95)');
    s.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = s;
    g.fillRect(0, 0, n, n);
    const b = g.createRadialGradient(n * 0.5, n * 1.02, n * 0.1, n * 0.5, n * 1.02, n * 0.5);
    b.addColorStop(0, 'rgba(200,215,255,0.5)');
    b.addColorStop(1, 'rgba(200,215,255,0)');
    g.fillStyle = b;
    g.fillRect(0, 0, n, n);
  });
  const metal = matcapTexture((g, n) => {
    const l = g.createLinearGradient(0, 0, 0, n);
    [[0, '#fffdf2'], [0.22, '#f1d59a'], [0.45, '#8a6a33'], [0.55, '#ffe9b5'], [0.8, '#a9833f'], [1, '#4d3a1c']].forEach(([p, c]) => l.addColorStop(p, c));
    g.fillStyle = l;
    g.fillRect(0, 0, n, n);
    const s = g.createRadialGradient(n * 0.35, n * 0.25, 0, n * 0.35, n * 0.25, n * 0.2);
    s.addColorStop(0, 'rgba(255,255,255,0.9)');
    s.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = s;
    g.fillRect(0, 0, n, n);
  });
  caps = { soft, metal };
  return caps;
}

export function plastic(color, opts = {}) {
  return new THREE.MeshMatcapMaterial({ matcap: matcaps().soft, color, ...opts });
}
export function brass(color = 0xffffff, opts = {}) {
  return new THREE.MeshMatcapMaterial({ matcap: matcaps().metal, color, ...opts });
}
export function glow(color, opacity = 1, opts = {}) {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1 || !!opts.blending, opacity, depthWrite: false, toneMapped: false, ...opts });
}

// ---- icons and text ------------------------------------------------------

/** Draw a lucide icon (24-unit grid) centred on x, y. */
export function drawIcon(g, node, x, y, size, color, { fill = false, width = 2.2 } = {}) {
  if (!node) return;
  g.save();
  g.translate(x - size / 2, y - size / 2);
  g.scale(size / 24, size / 24);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [tag, a] of node) {
    g.beginPath();
    let path = null;
    if (tag === 'path') path = new Path2D(a.d);
    else if (tag === 'circle') g.arc(+a.cx, +a.cy, +a.r, 0, Math.PI * 2);
    else if (tag === 'ellipse') g.ellipse(+a.cx, +a.cy, +a.rx, +a.ry, 0, 0, Math.PI * 2);
    else if (tag === 'line') {
      g.moveTo(+a.x1, +a.y1);
      g.lineTo(+a.x2, +a.y2);
    } else if (tag === 'rect') g.roundRect(+a.x || 0, +a.y || 0, +a.width, +a.height, +(a.rx || 0));
    else if (tag === 'polyline' || tag === 'polygon') {
      const pts = String(a.points).trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i + 1 < pts.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, pts[i], pts[i + 1]);
      if (tag === 'polygon') g.closePath();
    } else continue;
    if (path) {
      if (fill) g.fill(path);
      g.stroke(path);
    } else {
      if (fill) g.fill();
      g.stroke();
    }
  }
  g.restore();
}

function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A line of text floating in the workspace. Always built facing its parent's +Z. */
export class Label {
  constructor({ width = 0.3, size = 0.012, color = '#ffffff', weight = 650, align = 'center', outline = 'rgba(8,10,20,0.85)', opacity = 1 } = {}) {
    this.size = size;
    this.color = color;
    this.weight = weight;
    this.align = align;
    this.outline = outline;
    this.text = null;
    this.font = 44;
    const h = Math.round(this.font * 1.6);
    const w = Math.round((width / size) * this.font);
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.tex = canvasTexture(this.canvas);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, (h / this.font) * size), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false, opacity }));
    this.mesh.renderOrder = 20;
    this.set('');
  }
  set(text, color) {
    if (text === this.text && (color || this.color) === this.color) return;
    this.text = text;
    if (color) this.color = color;
    const g = this.canvas.getContext('2d');
    const { width: w, height: h } = this.canvas;
    g.clearRect(0, 0, w, h);
    if (!text) {
      this.tex.needsUpdate = true;
      return;
    }
    let px = this.font;
    g.font = `${this.weight} ${px}px ${FONT}`;
    const m = g.measureText(text).width;
    if (m > w - 16) {
      px = Math.max(18, Math.floor((px * (w - 16)) / m));
      g.font = `${this.weight} ${px}px ${FONT}`;
    }
    g.textBaseline = 'middle';
    g.textAlign = this.align;
    const x = this.align === 'left' ? 8 : this.align === 'right' ? w - 8 : w / 2;
    if (this.outline) {
      g.lineJoin = 'round';
      g.lineWidth = Math.max(4, px * 0.2);
      g.strokeStyle = this.outline;
      g.strokeText(text, x, h / 2 + 1);
    }
    g.fillStyle = this.color;
    g.fillText(text, x, h / 2 + 1);
    this.tex.needsUpdate = true;
  }
}

// ---- push button ---------------------------------------------------------

const BASE_H = 0.006;
const CAP_H = 0.016;
const TRAVEL = 0.010;
const FIRE = 0.0055;
const RELEASE = 0.002;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * A real key: a cap that sinks under a fingertip and fires when it has
 * travelled about half a centimetre. It only yields to a finger that came
 * down onto its top, so a hand sweeping sideways through it does nothing.
 */
export class Button3D {
  constructor({ key, w = 0.068, h = 0.056, round = false, color = C.cream, ink = C.ink, icon = null, label = '', fillIcon = false, onPress = null }) {
    this.key = key;
    this.round = round;
    this.hw = w / 2;
    this.hh = round ? w / 2 : h / 2;
    this.top = BASE_H + CAP_H;
    this.onPress = onPress;
    this.enabled = true;
    this.state = {};
    this.depth = 0;
    this.hover = 0;
    this.hoverNow = false;
    this.flash = 0;
    this.firedAt = -1e9;
    this.pop = 1;
    this.inv = new THREE.Matrix4();
    this.face = { icon, label, ink, fillIcon };
    this.baseColor = new THREE.Color(color);

    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    const baseGeo = round ? new THREE.CylinderGeometry(this.hw + 0.006, this.hw + 0.008, BASE_H, 40).rotateX(Math.PI / 2) : new RoundedBoxGeometry(w + 0.012, h + 0.012, BASE_H, 4, 0.0028);
    this.base = new THREE.Mesh(baseGeo, plastic(C.darker));
    this.base.position.z = BASE_H / 2;
    const capGeo = round ? new THREE.CylinderGeometry(this.hw - 0.002, this.hw, CAP_H, 40).rotateX(Math.PI / 2) : new RoundedBoxGeometry(w, h, CAP_H, 5, 0.0062);
    this.capMat = plastic(color);
    this.cap = new THREE.Mesh(capGeo, this.capMat);
    this.cap.position.z = BASE_H + CAP_H / 2;
    this.cap.userData.pick = { type: 'button', ref: this };

    const fw = round ? w * 0.74 : w - 0.008;
    const fh = round ? w * 0.74 : h - 0.008;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(fw * PX);
    this.canvas.height = Math.round(fh * PX);
    this.tex = canvasTexture(this.canvas);
    this.decal = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false }));
    this.decal.position.z = CAP_H / 2 + 0.0004;
    this.decal.renderOrder = 5;
    this.cap.add(this.decal);
    this.body.add(this.base, this.cap);
    this.draw();
  }

  setFace(patch) {
    const next = { ...this.face, ...patch };
    if (next.icon === this.face.icon && next.label === this.face.label && next.ink === this.face.ink) return;
    this.face = next;
    this.draw();
  }
  setColor(color) {
    this.baseColor.set(color);
  }

  draw() {
    const g = this.canvas.getContext('2d');
    const { width: w, height: h } = this.canvas;
    const { icon, label, ink, fillIcon } = this.face;
    g.clearRect(0, 0, w, h);
    if (icon && label) {
      const s = Math.min(w * 0.46, h * 0.5);
      drawIcon(g, icon, w / 2, h * 0.36, s, ink, { fill: fillIcon });
      let px = Math.round(h * 0.2);
      g.font = `700 ${px}px ${FONT}`;
      const m = g.measureText(label).width;
      if (m > w - 10) g.font = `700 ${Math.floor((px * (w - 10)) / m)}px ${FONT}`;
      g.fillStyle = ink;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, w / 2, h * 0.8);
    } else if (icon) {
      drawIcon(g, icon, w / 2, h / 2, Math.min(w, h) * 0.74, ink, { fill: fillIcon, width: 2.4 });
    } else if (label) {
      let px = Math.round(h * 0.42);
      g.font = `750 ${px}px ${FONT}`;
      const m = g.measureText(label).width;
      if (m > w - 10) g.font = `750 ${Math.floor((px * (w - 10)) / m)}px ${FONT}`;
      g.fillStyle = ink;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, w / 2, h / 2 + 1);
    }
    this.tex.needsUpdate = true;
  }

  /** Remember where this key sits in workspace space. Call after layout. */
  bind(rig) {
    this.group.updateWorldMatrix(true, false);
    this.inv.copy(rig.matrixWorld).invert().multiply(this.group.matrixWorld).invert();
  }

  within(x, y, pad) {
    return this.round ? Math.hypot(x, y) <= this.hw + pad : Math.abs(x) <= this.hw + pad && Math.abs(y) <= this.hh + pad;
  }

  /** Feed a fingertip (workspace space). Returns true on the frame the key fires. */
  touch(side, tip, prev, radius, now) {
    const st = (this.state[side] ||= { armed: false, pressed: false, push: 0 });
    if (!this.enabled || !this.group.visible || this.pop < 0.9) {
      st.armed = st.pressed = false;
      st.push = 0;
      return false;
    }
    _p.copy(tip).applyMatrix4(this.inv);
    const hz = _p.z - radius - this.top; // finger skin above the resting cap top; negative = pushed in
    const inside = this.within(_p.x, _p.y, 0.008);
    if (!inside || hz > 0.08 || hz < -0.075) {
      st.armed = st.pressed = false;
      st.push = 0;
      return false;
    }
    if (hz < 0.05) this.hoverNow = true;
    if (!st.armed && !st.pressed) {
      if (hz > -0.003) st.armed = true;
      else if (prev) {
        // A quick diagonal poke: did the finger pass down through the top face?
        _q.copy(prev).applyMatrix4(this.inv);
        const qz = _q.z - radius - this.top;
        if (qz > 0) {
          const t = qz / (qz - hz);
          if (this.within(_q.x + (_p.x - _q.x) * t, _q.y + (_p.y - _q.y) * t, 0.014)) st.armed = true;
        }
      }
    }
    if (!st.armed && !st.pressed) {
      st.push = 0;
      return false;
    }
    st.push = Math.max(0, Math.min(TRAVEL, -hz));
    let fired = false;
    if (!st.pressed && -hz >= FIRE) {
      st.pressed = true;
      if (now - this.firedAt > 240) fired = true;
    } else if (st.pressed && -hz < RELEASE) st.pressed = false;
    if (fired) this.fire(side, now);
    return fired;
  }

  /** Is a pinch (workspace space) on or just above this key? */
  pinchHit(point) {
    if (!this.enabled || !this.group.visible) return false;
    _p.copy(point).applyMatrix4(this.inv);
    return this.within(_p.x, _p.y, 0.012) && _p.z > -0.02 && _p.z < this.top + 0.045;
  }

  fire(side, now = performance.now()) {
    if (!this.enabled) return;
    this.firedAt = now;
    this.flash = 1;
    this.onPress?.(side, this);
  }

  release(side) {
    const st = this.state[side];
    if (st) {
      st.armed = st.pressed = false;
      st.push = 0;
    }
  }

  animate(dt) {
    let push = 0;
    for (const k in this.state) push = Math.max(push, this.state[k].push);
    if (this.flash > 0.55) push = Math.max(push, TRAVEL * 0.8);
    this.depth += (push - this.depth) * Math.min(1, dt * (push > this.depth ? 60 : 22));
    this.hover += ((this.hoverNow ? 1 : 0) - this.hover) * Math.min(1, dt * 14);
    this.hoverNow = false;
    this.flash = Math.max(0, this.flash - dt * 3.4);
    this.cap.position.z = BASE_H + CAP_H / 2 - this.depth + this.hover * 0.0012;
    const k = this.enabled ? 1 : 0.42;
    const lift = 0.94 + this.hover * 0.1 + this.flash * 0.35;
    this.capMat.color.copy(this.baseColor).multiplyScalar(k * lift);
    this.decal.material.opacity = this.enabled ? 1 : 0.45;
    const s = this.pop;
    this.body.scale.setScalar(Math.max(0.0001, s));
    this.body.visible = s > 0.001;
  }
}

// ---- film strip textures -------------------------------------------------

const stripCache = new Map();
function stripBase(src) {
  let base = stripCache.get(src.id);
  if (!base) {
    base = canvasTexture(src.strip.canvas);
    stripCache.set(src.id, base);
  }
  return base;
}
/** A window onto a recording's film strip. All windows share one image on the GPU. */
export function stripWindow(src) {
  const tex = stripBase(src).clone();
  tex.needsUpdate = true;
  return { tex, version: src.strip.version, src: src.id };
}
/** Call each frame: re-uploads when new thumbnails have been drawn. */
export function syncStrip(win, src) {
  if (win.version !== src.strip.version) {
    win.version = src.strip.version;
    win.tex.needsUpdate = true;
  }
}

// ---- sparks ---------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _id = new THREE.Quaternion();
const _col = new THREE.Color();

export class Sparks {
  constructor(parent, count = 96) {
    this.count = count;
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 30;
    this.p = Array.from({ length: count }, () => ({ life: 0, max: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 0.004, color: new THREE.Color() }));
    this.next = 0;
    this.live = 0;
    for (let i = 0; i < count; i++) {
      this.mesh.setMatrixAt(i, _m4.makeScale(0, 0, 0));
      this.mesh.setColorAt(i, _col.set(0xffffff));
    }
    parent.add(this.mesh);
  }
  /** pos: workspace space. dir: optional bias. */
  burst(pos, { n = 16, color = 0xffffff, color2 = null, speed = 0.9, spread = 1, up = 0.25, size = 0.0045, life = 0.5, plane = null } = {}) {
    for (let i = 0; i < n; i++) {
      const q = this.p[this.next];
      this.next = (this.next + 1) % this.count;
      q.pos.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.5) * Math.PI * spread;
      _v.set(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e));
      if (plane === 'yz') _v.x *= 0.25;
      if (plane === 'xy') _v.z = Math.abs(_v.z) * 0.6;
      q.vel.copy(_v).normalize().multiplyScalar(speed * (0.35 + Math.random() * 0.75));
      q.vel.y += up;
      q.max = q.life = life * (0.6 + Math.random() * 0.7);
      q.size = size * (0.6 + Math.random() * 0.9);
      q.color.set(color2 && Math.random() < 0.5 ? color2 : color);
    }
    this.live = Math.max(this.live, 1);
  }
  update(dt) {
    if (!this.live) return;
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      const q = this.p[i];
      if (q.life <= 0) continue;
      q.life -= dt;
      if (q.life <= 0) {
        this.mesh.setMatrixAt(i, _m4.makeScale(0, 0, 0));
        continue;
      }
      live++;
      q.vel.y -= 2.6 * dt;
      q.vel.multiplyScalar(1 - Math.min(1, dt * 2.2));
      q.pos.addScaledVector(q.vel, dt);
      const k = q.life / q.max;
      _s3.setScalar(q.size * (0.25 + 0.75 * k));
      _m4.compose(q.pos, _id, _s3);
      this.mesh.setMatrixAt(i, _m4);
      this.mesh.setColorAt(i, q.color);
    }
    this.live = live;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export const ease = {
  outBack: (t) => {
    const c = 1.70158 * 1.35;
    const u = t - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  },
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
};
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

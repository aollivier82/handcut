// The workspace: everything the editor sees and touches, laid out around
// where their eyes were when they arrived.
//
//   far, large    the screen (nothing to touch, so it can be cinema sized)
//   arm's length  three tracks of pills that slide under a fixed cut line
//   look down     the console: Play, the film belt you swipe, the scrub dial
//   right         tool keys, turned to face the editor
//   left          the library shelf of recordings
//
// All coordinates here are metres in "workspace space": origin at the eyes,
// -Z forward, +X right.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  Undo2, Redo2, Scissors, Trash2, Volume2, VolumeX, RectangleVertical, RectangleHorizontal, FolderInput, Upload,
  LocateFixed, LogOut, Play, Pause, ZoomIn, ZoomOut, Plus, Check, X,
} from 'lucide';
import { Button3D, Label, Sparks, plastic, brass, glow, C, stripWindow, syncStrip, drawIcon, ease, clamp, damp, FONT } from './ui3d.js';
import { FPS, clipLen, clipEnd, findClip, timecode, seconds } from './model.js';
import { sfx } from './sfx.js';

export const LAY = {
  halfW: 0.36,
  pitch: 0.074,
  R: 0.026, // pill half height
  D: 0.014, // pill half depth
  bench: { pos: [0, -0.235, -0.5], tilt: -28 },
  console: { pos: [0, -0.405, -0.345], tilt: -56 },
  rack: { pos: [0.535, -0.215, -0.385] },
  lib: { pos: [-0.515, -0.235, -0.395], pitch: 0.086, rows: 4, tileW: 0.132, tileH: 0.078 },
  screen: { pos: [0, 0.7, -3.2], tall: [1.4625, 2.6], wide: [4.2, 2.3625] },
  belt: { y: -0.04, halfW: 0.27, halfH: 0.03, top: 0.014 },
  rail: { y: 0.047, halfW: 0.23, z: 0.012 },
  play: { x: -0.345, y: 0.004 },
  bar: { y: -0.108, halfW: 0.13 },
};
export const laneY = (t) => (t - 1) * LAY.pitch;

const DEG = Math.PI / 180;
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

function faceEye(group) {
  // Turn a cluster so its +Z looks at the editor's eyes (the workspace origin).
  _m.lookAt(new THREE.Vector3(0, 0, 0), group.position, new THREE.Vector3(0, 1, 0));
  group.quaternion.setFromRotationMatrix(_m);
}

function stretchable(material) {
  material.userData.stretch = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStretch = material.userData.stretch;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uStretch;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += sign(position.x) * uStretch;');
  };
  material.customProgramCacheKey = () => 'handcut-stretch';
  return material;
}

let pillGeo = null;
let handleGeo = null;
function geometries() {
  if (!pillGeo) {
    pillGeo = new THREE.CapsuleGeometry(LAY.R, 0.0004, 10, 24);
    pillGeo.rotateZ(Math.PI / 2);
    pillGeo.scale(1, 1, LAY.D / LAY.R);
    pillGeo.computeVertexNormals();
    handleGeo = new RoundedBoxGeometry(0.0085, 0.036, 0.013, 3, 0.0038);
  }
}

class PillView {
  constructor(stage, clip) {
    geometries();
    this.stage = stage;
    this.id = clip.id;
    this.group = new THREE.Group();
    this.inner = new THREE.Group();
    this.group.add(this.inner);
    const planes = stage.clipPlanes;
    this.bodyMat = stretchable(plastic(0xffffff, { clippingPlanes: planes }));
    this.body = new THREE.Mesh(pillGeo, this.bodyMat);
    this.body.frustumCulled = false;
    this.body.userData.pick = { type: 'pill', id: clip.id };
    this.rimMat = stretchable(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, clippingPlanes: planes, toneMapped: false }));
    this.rim = new THREE.Mesh(pillGeo, this.rimMat);
    this.rim.frustumCulled = false;
    this.rim.scale.set(1, 1.2, 1.25);
    this.rim.visible = false;
    this.hIn = new THREE.Mesh(handleGeo, plastic(C.mint, { clippingPlanes: planes }));
    this.hOut = new THREE.Mesh(handleGeo, plastic(C.amber, { clippingPlanes: planes }));
    this.hIn.userData.pick = { type: 'pill', id: clip.id, edge: 'in' };
    this.hOut.userData.pick = { type: 'pill', id: clip.id, edge: 'out' };
    this.inner.add(this.rim, this.body, this.hIn, this.hOut);
    this.films = [];
    this.filmKey = '';
    this.muteTag = null;
    stage.bench.add(this.group);

    this.track = 0;
    this.x = 0; // centre, bench space
    this.y = 0;
    this.lenM = 0.05;
    this.dispAt = clip.at;
    this.dispLen = clipLen(clip);
    this.fresh = true;
    this.held = false;
    this.heldPos = new THREE.Vector3();
    this.pop = 1;
    this.squash = 0; // spring: positive = stretched
    this.squashV = 0;
    this.wobble = 0;
    this.kick = 0; // sideways shove after a cut
    this.kickV = 0;
    this.hoverIn = 0;
    this.hoverOut = 0;
    this.selected = false;
    this.clipped = true;
    this.dying = 0;
    this.color = new THREE.Color(0x888888);
  }

  /** A pill in the hand can leave the bench; one on the bench is clipped at the spools. */
  setClipped(on) {
    if (this.clipped === on) return;
    this.clipped = on;
    const planes = on ? this.stage.clipPlanes : null;
    for (const m of [this.bodyMat, this.rimMat, this.hIn.material, this.hOut.material, ...this.films.map((f) => f.mesh.material)]) {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
  }

  films_(clip) {
    const lib = this.stage.library;
    const key = clip.segs.map((s) => s.src).join('|');
    if (key === this.filmKey) return;
    this.filmKey = key;
    for (const f of this.films) {
      this.inner.remove(f.mesh);
      f.win.tex.dispose();
      f.mesh.material.dispose();
    }
    this.films = clip.segs.map((s) => {
      const src = lib.get(s.src);
      const win = stripWindow(src);
      const mesh = new THREE.Mesh(this.stage.unitPlane, new THREE.MeshBasicMaterial({ map: win.tex, clippingPlanes: this.clipped ? this.stage.clipPlanes : null, toneMapped: false }));
      mesh.userData.pick = { type: 'pill', id: this.id };
      mesh.position.z = LAY.D + 0.0006;
      this.inner.add(mesh);
      return { mesh, win, src };
    });
  }

  /** x0/len in metres along the bench; y lane height. */
  place(clip, x0, lenM, y, dt, state) {
    const { R, D } = LAY;
    this.lenM = lenM;
    this.x = x0 + lenM / 2;
    this.y = y;
    const src0 = this.stage.library.get(clip.segs[0].src);
    this.color.set(src0?.color || '#888888');
    this.films_(clip);

    // body: a capsule stretched to length; very short clips squash instead
    const visLen = Math.max(0.006, lenM - 0.003); // hairline gap between neighbours
    const stretch = Math.max(0, visLen / 2 - R);
    const sx = visLen < 2 * R ? visLen / (2 * R) : 1;
    this.bodyMat.userData.stretch.value = stretch;
    this.rimMat.userData.stretch.value = stretch + 0.0012;
    this.body.scale.x = sx;
    this.rim.scale.x = sx * 1.04;

    // film window, one piece per source interval
    const inset = Math.min(0.017, visLen * 0.2);
    const filmW = Math.max(0, visLen - inset * 2);
    const total = clipLen(clip);
    let acc = 0;
    for (let i = 0; i < this.films.length; i++) {
      const f = this.films[i];
      const s = clip.segs[i];
      const n = s.out - s.in;
      const w = (filmW * n) / total;
      f.mesh.visible = filmW > 0.012;
      f.mesh.scale.set(Math.max(0.0001, w - 0.0012), R * 1.18, 1);
      f.mesh.position.x = -filmW / 2 + (filmW * acc) / total + w / 2;
      const frames = Math.max(1, f.src.frames);
      f.win.tex.repeat.set(n / frames, 1);
      f.win.tex.offset.set(s.in / frames, 0);
      syncStrip(f.win, f.src);
      acc += n;
    }

    // handles
    const hs = clamp(visLen / 0.04, 0.35, 1);
    const hx = visLen / 2 - 0.0078 * hs;
    this.hoverIn = damp(this.hoverIn, state.hotIn ? 1 : 0, 16, dt);
    this.hoverOut = damp(this.hoverOut, state.hotOut ? 1 : 0, 16, dt);
    const baseS = this.selected ? 1.0 : 0.82;
    this.hIn.position.set(-hx, 0, D * 0.62);
    this.hOut.position.set(hx, 0, D * 0.62);
    this.hIn.scale.set(hs * (baseS + this.hoverIn * 0.45), baseS + this.hoverIn * 0.25, 1 + this.hoverIn * 0.6);
    this.hOut.scale.set(hs * (baseS + this.hoverOut * 0.45), baseS + this.hoverOut * 0.25, 1 + this.hoverOut * 0.6);
    this.hIn.material.color.set(state.limitIn ? C.red : C.mint);
    this.hOut.material.color.set(state.limitOut ? C.red : C.amber);

    // springs: squash and stretch, sideways kick
    const k = 520;
    const c = 26;
    this.squashV += (-k * this.squash - c * this.squashV) * dt;
    this.squash += this.squashV * dt;
    this.kickV += (-380 * this.kick - 22 * this.kickV) * dt;
    this.kick += this.kickV * dt;
    this.wobble = Math.max(0, this.wobble - dt * 2.6);
    const wob = Math.sin(this.wobble * 34) * this.wobble * 0.12;

    const sel = this.selected;
    this.rim.visible = sel || state.merge > 0;
    if (this.rim.visible) {
      const pulse = 0.82 + 0.18 * Math.sin(state.now * 0.006);
      this.rimMat.color.set(state.merge > 0 ? C.amber : 0xffffff).multiplyScalar(pulse);
    }
    const lit = (sel ? 1.12 : 0.9) + (state.merge > 0 ? 0.25 : 0);
    this.bodyMat.color.copy(this.color).multiplyScalar(clip.muted ? lit * 0.55 : lit);
    for (const f of this.films) f.mesh.material.color.setScalar(clip.muted ? 0.45 : 1);

    const pop = this.pop * (1 - this.dying);
    const s = Math.max(0.0001, pop);
    this.inner.scale.set(s * (1 + this.squash), s * (1 - this.squash * 0.6), s);
    this.inner.rotation.z = wob;
    if (this.held) {
      this.group.position.lerp(this.heldPos, 1 - Math.exp(-dt * 40));
    } else {
      _v.set(this.x + this.kick, y, sel ? 0.004 : 0);
      if (this.fresh) this.group.position.copy(_v);
      else {
        // x is exact (it is the timeline); height and depth ease back from the hand
        this.group.position.x = _v.x;
        this.group.position.y = damp(this.group.position.y, _v.y, 18, dt);
        this.group.position.z = damp(this.group.position.z, _v.z, 18, dt);
      }
    }
    this.fresh = false;
  }

  dispose() {
    this.stage.bench.remove(this.group);
    for (const f of this.films) {
      f.win.tex.dispose();
      f.mesh.material.dispose();
    }
    this.bodyMat.dispose();
    this.rimMat.dispose();
    this.hIn.material.dispose();
    this.hOut.material.dispose();
  }
}

export class Stage {
  constructor(scene, editor, library, player, app) {
    this.editor = editor;
    this.library = library;
    this.player = player;
    this.app = app;
    this.rig = new THREE.Group();
    this.rig.name = 'workspace';
    scene.add(this.rig);
    this.unitPlane = new THREE.PlaneGeometry(1, 1);
    this.clipPlanes = [new THREE.Plane(), new THREE.Plane()];
    this.buttons = [];
    this.pills = new Map();
    this.tiles = [];
    this.pops = []; // things that pop in on arrival: { obj | button | view, order }
    this.intro = null;
    this.noticeText = '';
    this.noticeUntil = 0;
    this.libScroll = 0;
    this.libVel = 0;
    this.hot = { id: null, edge: null }; // handle a hand is hovering
    this.armed = 0;
    this.mergeFx = null;
    this.exportState = { busy: false, progress: 0, ready: false };
    this.benchInv = new THREE.Matrix4();
    this.consoleInv = new THREE.Matrix4();
    this.libInv = new THREE.Matrix4();
    this.rackInv = new THREE.Matrix4();
    this.rigInv = new THREE.Matrix4();
    this.ratioK = editor.project.ratio === '9:16' ? 0 : 1;

    this.buildBackdrop();
    this.buildScreen();
    this.buildBench();
    this.buildConsole();
    this.buildRack();
    this.buildLibrary();
    this.sparks = new Sparks(this.rig, 110);
    this.bind();
    this.wire();
    library.onChange(() => this.refreshTiles());
    this.refreshTiles();
  }

  // ---- construction ------------------------------------------------------

  buildBackdrop() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(45, 32, 20),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: /* glsl */ `
          varying vec3 vP;
          void main() {
            vec3 d = normalize(vP);
            float h = d.y * 0.5 + 0.5;
            vec3 low = vec3(0.016, 0.018, 0.04);
            vec3 mid = vec3(0.075, 0.055, 0.14);
            vec3 high = vec3(0.022, 0.028, 0.07);
            vec3 c = mix(low, mid, smoothstep(0.18, 0.52, h));
            c = mix(c, high, smoothstep(0.52, 0.95, h));
            float ahead = max(0.0, -d.z);
            c += vec3(0.05, 0.035, 0.11) * pow(ahead, 3.0) * exp(-pow((d.y - 0.18) * 2.2, 2.0));
            float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
            gl_FragColor = vec4(c + (n - 0.5) * 0.006, 1.0);
          }`,
      }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.rig.add(sky);

    // a pool of light under the desk so the room has a floor
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const r = g.createRadialGradient(128, 128, 6, 128, 128, 128);
    r.addColorStop(0, 'rgba(120,110,220,0.55)');
    r.addColorStop(0.4, 'rgba(70,60,150,0.22)');
    r.addColorStop(1, 'rgba(40,30,90,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(160,170,255,0.16)';
    g.lineWidth = 1.2;
    for (const rad of [40, 76, 112]) {
      g.beginPath();
      g.arc(128, 128, rad, 0, Math.PI * 2);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.35, -1.2);
    floor.renderOrder = -9;
    this.rig.add(floor);
    this.pops.push({ obj: floor, order: 0 });
  }

  buildScreen() {
    const s = (this.screen = new THREE.Group());
    s.position.fromArray(LAY.screen.pos);
    this.rig.add(s);
    this.screenBack = new THREE.Mesh(new RoundedBoxGeometry(1, 1, 0.06, 4, 0.02), plastic(0x10121c));
    this.screenBack.position.z = -0.04;
    const haloC = document.createElement('canvas');
    haloC.width = haloC.height = 128;
    const hg = haloC.getContext('2d');
    const hr = hg.createRadialGradient(64, 64, 10, 64, 64, 64);
    hr.addColorStop(0, 'rgba(130,120,255,0.5)');
    hr.addColorStop(1, 'rgba(130,120,255,0)');
    hg.fillStyle = hr;
    hg.fillRect(0, 0, 128, 128);
    const haloT = new THREE.CanvasTexture(haloC);
    haloT.colorSpace = THREE.SRGBColorSpace;
    this.halo = new THREE.Mesh(this.unitPlane, new THREE.MeshBasicMaterial({ map: haloT, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
    this.halo.position.z = -0.12;
    this.halo.renderOrder = -5;
    this.black = new THREE.Mesh(this.unitPlane, new THREE.MeshBasicMaterial({ color: 0x05060a, toneMapped: false }));
    this.black.position.z = -0.002;
    this.bandMeshes = [0, 1, 2].map(() => {
      const m = new THREE.Mesh(this.unitPlane, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
      m.visible = false;
      return m;
    });
    this.flash = new THREE.Mesh(this.unitPlane, glow(0xffffff, 0, { blending: THREE.AdditiveBlending }));
    this.flash.position.z = 0.004;
    this.flash.visible = false;
    this.idle = new Label({ width: 1.3, size: 0.11, color: '#8f95c4', weight: 700, outline: null });
    this.idle.set('Handcut');
    this.idle.mesh.position.set(0, 0.06, 0.003);
    this.idleSub = new Label({ width: 1.3, size: 0.045, color: '#6c7198', weight: 600, outline: null });
    this.idleSub.set('Bring a recording to a track');
    this.idleSub.mesh.position.set(0, -0.1, 0.003);
    this.progress = new THREE.Mesh(this.unitPlane, glow(C.mint, 1));
    this.progress.visible = false;
    this.progress.position.z = 0.006;
    s.add(this.halo, this.screenBack, this.black, ...this.bandMeshes, this.flash, this.idle.mesh, this.idleSub.mesh, this.progress);
    this.pops.push({ obj: s, order: 1 });
  }

  buildBench() {
    const b = (this.bench = new THREE.Group());
    b.position.fromArray(LAY.bench.pos);
    b.rotation.x = LAY.bench.tilt * DEG;
    this.rig.add(b);
    const { halfW, pitch, R, D } = LAY;
    this.laneMarks = [];
    for (let t = 0; t < 3; t++) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2, 0.0035, 0.0035), plastic(0x3a3f5c));
      rail.position.set(0, laneY(t), -D * 0.6);
      b.add(rail);
      this.pops.push({ obj: rail, order: 2 + t });
      const bead = new THREE.Mesh(new RoundedBoxGeometry(0.026, 0.026, 0.012, 3, 0.006), plastic(0x3d4468));
      bead.position.set(-halfW - 0.04, laneY(t), 0);
      const num = new Label({ width: 0.03, size: 0.014, color: '#dfe3ff', weight: 800, outline: null });
      num.set(String(t + 1));
      num.mesh.position.z = 0.0065;
      bead.add(num.mesh);
      b.add(bead);
      this.laneMarks.push(bead);
      this.pops.push({ obj: bead, order: 2 + t });
    }
    // the film feeds through a spool at each end
    for (const side of [-1, 1]) {
      const spool = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, pitch * 2 + 0.03, 6, 16), brass(0xffffff));
      spool.position.set(side * (halfW + 0.008), 0, 0.002);
      b.add(spool);
      this.pops.push({ obj: spool, order: 4 });
    }
    // the cut line: fixed, the film moves under it
    const head = (this.head = new THREE.Group());
    const needle = new THREE.Mesh(new THREE.BoxGeometry(0.0022, pitch * 2 + R * 2 + 0.03, 0.0022), glow(C.amber));
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.016, 4), glow(C.amber));
    cap.rotation.z = Math.PI;
    cap.position.y = pitch + R + 0.024;
    head.add(needle, cap);
    head.position.z = D + 0.008;
    b.add(head);
    this.pops.push({ obj: head, order: 5 });
    // the blade: lights up on the selected pill when it can be cut here
    this.blade = new THREE.Mesh(new THREE.BoxGeometry(0.0042, R * 2 + 0.022, 0.006), glow(0xffffff, 0.95, { blending: THREE.AdditiveBlending }));
    this.blade.position.z = D + 0.009;
    this.blade.visible = false;
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.34), glow(C.amber, 0.0, { blending: THREE.AdditiveBlending }));
    this.beam.position.z = D + 0.007;
    this.beam.visible = false;
    this.slash = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.3), glow(0xffffff, 0, { blending: THREE.AdditiveBlending }));
    this.slash.position.z = D + 0.02;
    this.slash.visible = false;
    this.slashT = 0;
    // where a carried pill will land
    geometries();
    this.ghostMat = stretchable(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.26, depthWrite: false, clippingPlanes: this.clipPlanes, toneMapped: false }));
    this.ghost = new THREE.Mesh(pillGeo, this.ghostMat);
    this.ghost.frustumCulled = false;
    this.ghost.visible = false;
    // merge ring
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.0032, 8, 40), glow(C.amber, 0.9));
    this.ringFill = new THREE.Mesh(new THREE.CircleGeometry(0.031, 40), glow(C.amber, 0.5, { blending: THREE.AdditiveBlending }));
    this.ring.visible = this.ringFill.visible = false;
    b.add(this.blade, this.beam, this.slash, this.ghost, this.ring, this.ringFill);

    this.hint = new Label({ width: 0.72, size: 0.0125, color: '#e8ebff', weight: 650 });
    this.hint.mesh.position.set(0, pitch + R + 0.058, 0.01);
    b.add(this.hint.mesh);
    this.tag = new Label({ width: 0.2, size: 0.0115, color: '#ffffff', weight: 750 });
    this.tag.mesh.visible = false;
    b.add(this.tag.mesh);
  }

  buildConsole() {
    const c = (this.console = new THREE.Group());
    c.position.fromArray(LAY.console.pos);
    c.rotation.x = LAY.console.tilt * DEG;
    this.rig.add(c);
    const ed = this.editor;

    this.playBtn = this.addButton(c, { key: 'play', round: true, w: 0.086, color: C.orange, ink: '#2a1206', icon: Play, fillIcon: true }, LAY.play.x, LAY.play.y, () => {
      this.player.prime();
      ed.togglePlay();
    }, 6);

    // film belt: swipe it like a phone screen to move through the edit
    const { belt, rail } = LAY;
    const beltBody = new THREE.Mesh(new RoundedBoxGeometry(belt.halfW * 2 + 0.02, belt.halfH * 2 + 0.012, belt.top, 4, 0.006), plastic(0x1b1e2e));
    beltBody.position.set(0, belt.y, belt.top / 2);
    beltBody.userData.pick = { type: 'belt' };
    const tc = document.createElement('canvas');
    tc.width = 256;
    tc.height = 64;
    const g = tc.getContext('2d');
    g.fillStyle = '#23273b';
    g.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 16; i++) {
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.16)';
      g.fillRect(i * 16, 0, 8, 64);
    }
    g.fillStyle = '#e9ecff';
    g.fillRect(0, 0, 5, 64);
    g.fillStyle = 'rgba(233,236,255,0.6)';
    for (const q of [64, 128, 192]) g.fillRect(q, q === 128 ? 12 : 22, 3, q === 128 ? 40 : 20);
    this.beltTex = new THREE.CanvasTexture(tc);
    this.beltTex.colorSpace = THREE.SRGBColorSpace;
    this.beltTex.wrapS = THREE.RepeatWrapping;
    this.beltTex.anisotropy = 4;
    this.beltFace = new THREE.Mesh(new THREE.PlaneGeometry(belt.halfW * 2, belt.halfH * 2), new THREE.MeshBasicMaterial({ map: this.beltTex, toneMapped: false }));
    this.beltFace.position.set(0, belt.y, belt.top + 0.0005);
    this.beltFace.userData.pick = { type: 'belt' };
    const beltMark = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.014, 3), glow(C.amber));
    beltMark.position.set(0, belt.y + belt.halfH + 0.012, belt.top);
    beltMark.rotation.z = Math.PI;
    c.add(beltBody, this.beltFace, beltMark);
    this.pops.push({ obj: beltBody, order: 6 }, { obj: this.beltFace, order: 6 }, { obj: beltMark, order: 6 });

    // overview rail + brass dial: the whole edit, end to end
    const rod = new THREE.Mesh(new THREE.CapsuleGeometry(0.0062, rail.halfW * 2, 6, 14).rotateZ(Math.PI / 2), plastic(0x30354f));
    rod.position.set(0, rail.y, rail.z);
    rod.userData.pick = { type: 'rail' };
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = 512;
    this.mapCanvas.height = 24;
    this.mapTex = new THREE.CanvasTexture(this.mapCanvas);
    this.mapTex.colorSpace = THREE.SRGBColorSpace;
    this.map = new THREE.Mesh(new THREE.PlaneGeometry(rail.halfW * 2, 0.02), new THREE.MeshBasicMaterial({ map: this.mapTex, transparent: true, toneMapped: false }));
    this.map.position.set(0, rail.y + 0.022, rail.z - 0.004);
    this.map.userData.pick = { type: 'rail' };
    this.dial = new THREE.Group();
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.021, 0.02, 28).rotateX(Math.PI / 2), brass(0xffffff));
    knob.userData.pick = { type: 'dial' };
    const pip = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.024, 16).rotateX(Math.PI / 2), glow(C.amber));
    this.dial.add(knob, pip);
    this.dial.position.set(0, rail.y, rail.z + 0.012);
    c.add(rod, this.map, this.dial);
    this.pops.push({ obj: rod, order: 7 }, { obj: this.map, order: 7 }, { obj: this.dial, order: 8 });

    this.clock = new Label({ width: 0.3, size: 0.0155, color: '#ffffff', weight: 750 });
    this.clock.mesh.position.set(0, rail.y + 0.052, 0.014);
    c.add(this.clock.mesh);

    this.addButton(c, { key: 'zoomout', w: 0.046, h: 0.042, icon: ZoomOut }, 0.285, rail.y + 0.004, () => {
      if (ed.zoom(-1)) this.notice('Wider view');
    }, 8);
    this.addButton(c, { key: 'zoomin', w: 0.046, h: 0.042, icon: ZoomIn }, 0.342, rail.y + 0.004, () => {
      if (ed.zoom(1)) this.notice('Closer view');
    }, 8);

    // pinch this bar to drag the whole desk to where your arms like it
    const bar = (this.bar = new THREE.Mesh(new THREE.CapsuleGeometry(0.0085, LAY.bar.halfW * 2, 6, 14).rotateZ(Math.PI / 2), brass(0xffffff)));
    bar.position.set(0, LAY.bar.y, 0.012);
    bar.userData.pick = { type: 'bar' };
    const barText = new Label({ width: 0.24, size: 0.0085, color: '#9aa0c8', weight: 650, outline: null });
    barText.set('PINCH THIS BAR TO MOVE THE DESK');
    barText.mesh.position.set(0, LAY.bar.y - 0.021, 0.006);
    c.add(bar, barText.mesh);
    this.pops.push({ obj: bar, order: 9 }, { obj: barText.mesh, order: 9 });
  }

  addButton(parent, opts, x, y, onPress, order) {
    const b = new Button3D({
      ...opts,
      onPress: (side) => {
        sfx('press');
        onPress(side, b);
      },
    });
    b.group.position.set(x, y, 0);
    parent.add(b.group);
    this.buttons.push(b);
    this.pops.push({ button: b, order });
    return b;
  }

  buildRack() {
    const r = (this.rack = new THREE.Group());
    r.position.fromArray(LAY.rack.pos);
    faceEye(r);
    this.rig.add(r);
    const ed = this.editor;
    const app = this.app;
    const cx = 0.041;
    const row = (i) => (2 - i) * 0.07;
    const B = (o, col, i, fn) => this.addButton(r, o, col ? cx : -cx, row(i), fn, 10 + i * 2 + col);
    this.keys = {
      undo: B({ key: 'undo', icon: Undo2, label: 'Undo' }, 0, 0, () => {
        if (!ed.undo()) this.deny('Nothing to undo');
      }),
      redo: B({ key: 'redo', icon: Redo2, label: 'Redo' }, 1, 0, () => {
        if (!ed.redo()) this.deny('Nothing to redo');
      }),
      split: B({ key: 'split', icon: Scissors, label: 'Split', color: C.red, ink: '#2b0a0a' }, 0, 1, () => ed.splitAtPlayhead()),
      remove: B({ key: 'remove', icon: Trash2, label: 'Delete' }, 1, 1, () => ed.deleteSelected()),
      mute: B({ key: 'mute', icon: Volume2, label: 'Sound' }, 0, 2, () => ed.toggleMute()),
      ratio: B({ key: 'ratio', icon: RectangleVertical, label: '9:16' }, 1, 2, () => ed.toggleRatio()),
      import: B({ key: 'import', icon: FolderInput, label: 'Import' }, 0, 3, () => app.importVideos()),
      export: B({ key: 'export', icon: Upload, label: 'Export', color: C.mint, ink: '#06281f' }, 1, 3, () => app.exportVideo()),
      center: B({ key: 'center', icon: LocateFixed, label: 'Recenter' }, 0, 4, () => app.recenter()),
      exit: B({ key: 'exit', icon: LogOut, label: 'Leave VR' }, 1, 4, () => app.exitVR()),
    };
  }

  buildLibrary() {
    const l = (this.lib = new THREE.Group());
    l.position.fromArray(LAY.lib.pos);
    faceEye(l);
    this.rig.add(l);
    const { pitch, rows } = LAY.lib;
    const title = new Label({ width: 0.2, size: 0.011, color: '#aab0dc', weight: 750, outline: null });
    title.set('LIBRARY · SWIPE');
    title.mesh.position.set(0, (rows * pitch) / 2 + 0.018, 0.004);
    l.add(title.mesh);
    this.pops.push({ obj: title.mesh, order: 10 });
    const post = new THREE.Mesh(new THREE.CapsuleGeometry(0.004, rows * pitch, 4, 10), plastic(0x30354f));
    post.position.set(LAY.lib.tileW / 2 + 0.016, 0, 0);
    this.libThumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.0055, 0.04, 4, 10), brass(0xffffff));
    this.libThumb.position.set(LAY.lib.tileW / 2 + 0.016, 0, 0.003);
    l.add(post, this.libThumb);
    this.pops.push({ obj: post, order: 10 }, { obj: this.libThumb, order: 10 });
  }

  refreshTiles() {
    const { tileW, tileH } = LAY.lib;
    const want = [...this.library.list().map((s) => ({ src: s })), { import: true }];
    const old = new Map(this.tiles.map((t) => [t.key, t]));
    const next = [];
    for (const w of want) {
      const key = w.import ? '+import' : w.src.id;
      let t = old.get(key);
      if (t) old.delete(key);
      else {
        const group = new THREE.Group();
        const inner = new THREE.Group();
        group.add(inner);
        const body = new THREE.Mesh(new RoundedBoxGeometry(tileW, tileH, 0.016, 4, 0.007), plastic(w.import ? 0x343a5a : 0x20243a));
        body.userData.pick = { type: 'tile', key };
        inner.add(body);
        t = { key, group, inner, body, src: w.src || null, import: !!w.import, pop: this.intro ? 0 : 1, press: 0, y: 0 };
        const cv = document.createElement('canvas');
        cv.width = 384;
        cv.height = 64;
        const g = cv.getContext('2d');
        if (w.import) {
          g.fillStyle = '#e9ecff';
          g.font = `750 34px ${FONT}`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText('Import videos', 214, 34);
          drawIcon(g, Plus, 70, 32, 40, '#57e0c1', { width: 3 });
          const tex = new THREE.CanvasTexture(cv);
          tex.colorSpace = THREE.SRGBColorSpace;
          const face = new THREE.Mesh(new THREE.PlaneGeometry(tileW - 0.012, ((tileW - 0.012) * 64) / 384), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
          face.position.z = 0.0086;
          inner.add(face);
        } else {
          t.win = stripWindow(w.src);
          const cells = w.src.cells;
          t.win.tex.repeat.set(1 / cells, 1);
          t.win.tex.offset.set(Math.floor(cells / 2) / cells, 0);
          const thumbW = tileW - 0.012;
          const thumb = new THREE.Mesh(new THREE.PlaneGeometry(thumbW, tileH - 0.012), new THREE.MeshBasicMaterial({ map: t.win.tex, toneMapped: false }));
          thumb.position.z = 0.0085;
          thumb.userData.pick = { type: 'tile', key };
          const stripe = new THREE.Mesh(new THREE.PlaneGeometry(thumbW, 0.004), glow(w.src.color));
          stripe.position.set(0, (tileH - 0.012) / 2 - 0.002, 0.0088);
          g.font = `700 30px ${FONT}`;
          g.textBaseline = 'middle';
          g.lineWidth = 7;
          g.lineJoin = 'round';
          g.strokeStyle = 'rgba(8,10,20,0.9)';
          g.fillStyle = '#ffffff';
          const name = w.src.name.length > 14 ? w.src.name.slice(0, 13) + '…' : w.src.name;
          g.strokeText(name, 10, 36);
          g.fillText(name, 10, 36);
          g.textAlign = 'right';
          const d = seconds(w.src.frames);
          g.strokeText(d, 374, 36);
          g.fillText(d, 374, 36);
          const tex = new THREE.CanvasTexture(cv);
          tex.colorSpace = THREE.SRGBColorSpace;
          const cap = new THREE.Mesh(new THREE.PlaneGeometry(thumbW, (thumbW * 64) / 384), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
          cap.position.set(0, -(tileH - 0.012) / 2 + (thumbW * 64) / 384 / 2, 0.009);
          cap.renderOrder = 6;
          inner.add(thumb, stripe, cap);
        }
        this.lib.add(group);
      }
      next.push(t);
    }
    for (const t of old.values()) this.lib.remove(t.group);
    this.tiles = next;
  }

  bind() {
    this.rig.updateWorldMatrix(true, true);
    this.rigInv.copy(this.rig.matrixWorld).invert();
    const local = (g, out) => out.copy(this.rigInv).multiply(g.matrixWorld).invert();
    local(this.bench, this.benchInv);
    local(this.console, this.consoleInv);
    local(this.lib, this.libInv);
    local(this.rack, this.rackInv);
    for (const b of this.buttons) b.bind(this.rig);
  }

  // ---- feedback ----------------------------------------------------------

  wire() {
    const ed = this.editor;
    ed.on('select', ({ id }) => {
      const v = this.pills.get(id);
      if (v) v.squashV = 5.5;
      sfx('select');
    });
    ed.on('cut', ({ left, right, track }) => {
      sfx('cut');
      const a = this.pills.get(left);
      if (a) {
        a.kickV = -1.15;
        a.squashV = -4;
      }
      this.pendingKick = { id: right, v: 1.15 };
      this.slashT = 1;
      this.slash.position.y = laneY(track);
      this.flashT = 1;
      _v.set(0, laneY(track), LAY.D + 0.012);
      this.burstBench(_v, { n: 26, color: 0xffffff, color2: C.amber, speed: 0.85, plane: 'yz', size: 0.0042, life: 0.55, up: 0.15 });
      this.notice('Cut at ' + timecode(ed.time), 1400);
    });
    ed.on('denied', ({ reason, id }) => {
      sfx('denied');
      const v = this.pills.get(id || ed.project.selected);
      if (v) v.wobble = 1;
      this.notice(reason === 'select' ? 'Tap a pill to select it first' : 'Slide the film until the line is inside the pill', 2200);
    });
    ed.on('delete', ({ at, len, track }) => {
      sfx('poof');
      const x = this.frameX(at + len / 2);
      _v.set(clamp(x, -LAY.halfW, LAY.halfW), laneY(track), LAY.D);
      this.burstBench(_v, { n: 18, color: 0xbfc4ff, speed: 0.5, size: 0.005, life: 0.5, up: 0.2 });
      this.notice('Deleted', 1200);
    });
    ed.on('merge', ({ id }) => {
      this.pendingPop = id;
      this.notice('Merged into one pill', 1600);
    });
    ed.on('drop', ({ id }) => {
      const v = this.pills.get(id);
      if (v) v.squashV = -5;
      sfx('drop');
    });
    ed.on('return', () => sfx('drop'));
    ed.on('add', ({ id }) => {
      this.pendingPop = id;
      sfx('pop');
      this.notice('Added to the timeline', 1200);
    });
    ed.on('trimmed', ({ changed }) => changed && sfx('drop'));
    ed.on('undo', () => {
      sfx('undo');
      this.notice('Undone', 900);
    });
    ed.on('redo', () => {
      sfx('redo');
      this.notice('Redone', 900);
    });
    ed.on('mute', ({ muted }) => this.notice(muted ? 'Pill muted' : 'Sound back on', 1200));
    ed.on('ratio', ({ ratio }) => this.notice(ratio === '9:16' ? 'Tall video for TikTok' : 'Wide video', 1400));
    ed.on('play', () => sfx('play'));
    ed.on('pause', () => sfx('pause'));
    ed.on('notice', ({ text, long }) => this.notice(text, long ? 5000 : 2600));
  }

  notice(text, ms = 2000) {
    this.noticeText = text;
    this.noticeUntil = performance.now() + ms;
  }
  deny(text) {
    sfx('denied');
    this.notice(text, 1500);
  }

  burstBench(benchPoint, opts) {
    const p = benchPoint.clone().applyMatrix4(this.bench.matrix);
    this.sparks.burst(p, opts);
  }

  mergeBurst(benchPoint) {
    sfx('bing');
    setTimeout(() => sfx('pop'), 90);
    this.burstBench(benchPoint, { n: 34, color: C.amber, color2: 0xffffff, speed: 0.75, size: 0.005, life: 0.7, up: 0.3 });
    this.flashT = 0.6;
  }

  // ---- geometry queries (bench space) -------------------------------------

  get mPerFrame() {
    return this.editor.scale / FPS;
  }
  frameX(frame) {
    return (frame - this.editor.time) * this.mPerFrame;
  }
  xFrame(x) {
    return this.editor.time + x / this.mPerFrame;
  }

  /** The pill (and which part of it) under a point. */
  pillAt(p, pad = 0.012, zRange = 0.05) {
    if (Math.abs(p.x) > LAY.halfW + 0.02 || Math.abs(p.z - 0.004) > zRange) return null;
    let best = null;
    let score = Infinity;
    for (const v of this.pills.values()) {
      if (v.held || !v.group.visible || v.dying) continue;
      const dy = Math.abs(p.y - v.y);
      if (dy > LAY.R + pad) continue;
      const x0 = v.x - v.lenM / 2;
      const x1 = v.x + v.lenM / 2;
      if (p.x < x0 - pad || p.x > x1 + pad) continue;
      const out = Math.max(0, x0 - p.x, p.x - x1);
      const s = dy + out * 2;
      if (s < score) {
        score = s;
        const hz = v.lenM < 0.03 ? v.lenM * 0.34 : Math.min(0.024, v.lenM * 0.3);
        best = { view: v, zone: p.x < x0 + hz ? 'in' : p.x > x1 - hz ? 'out' : 'body' };
      }
    }
    return best;
  }
  pillOnLane(track, x, pad = 0.01) {
    for (const v of this.pills.values()) {
      if (v.held || v.track !== track || !v.group.visible || v.dying) continue;
      if (x >= v.x - v.lenM / 2 - pad && x <= v.x + v.lenM / 2 + pad) return v;
    }
    return null;
  }
  laneAt(y, z, tol = 0.048) {
    if (Math.abs(z) > 0.2) return -1;
    let best = -1;
    let d = tol;
    for (let t = 0; t < 3; t++) {
      const k = Math.abs(y - laneY(t));
      if (k < d) {
        d = k;
        best = t;
      }
    }
    return best;
  }
  /** Library tile under a point in library space. */
  tileAt(p, pad = 0.008) {
    const { tileW, tileH } = LAY.lib;
    if (Math.abs(p.x) > tileW / 2 + pad) return null;
    for (const t of this.tiles) {
      if (t.scale < 0.6) continue;
      if (Math.abs(p.y - t.y) <= tileH / 2 + pad * 0.5) return t;
    }
    return null;
  }
  maxLibScroll() {
    return Math.max(0, this.tiles.length - LAY.lib.rows);
  }
  dialX() {
    const d = this.editor.duration();
    return -LAY.rail.halfW + LAY.rail.halfW * 2 * (d ? clamp(this.editor.time / d, 0, 1) : 0);
  }

  viewFor(clip) {
    let v = this.pills.get(clip.id);
    if (!v) {
      v = new PillView(this, clip);
      this.pills.set(clip.id, v);
    }
    return v;
  }

  // ---- arrival -----------------------------------------------------------

  /** Pop everything into existence, one piece after another. */
  startIntro(now, quick = false) {
    const items = [];
    for (const p of this.pops) items.push({ ...p });
    for (const v of this.pills.values()) items.push({ view: v, order: 5.5 });
    this.tiles.forEach((t, i) => items.push({ tile: t, order: 9.5 + i * 0.5 }));
    items.sort((a, b) => a.order - b.order);
    let last = -1;
    let slot = -1;
    for (const it of items) {
      if (it.order !== last) {
        slot++;
        last = it.order;
      }
      it.at = now + (quick ? 0 : 120 + slot * 62);
      it.sounded = false;
      it.slot = slot;
      this.setPop(it, quick ? 1 : 0);
    }
    this.intro = quick ? null : { items, end: now + 120 + (slot + 1) * 62 + 600, slots: slot + 1 };
  }
  setPop(it, k) {
    if (it.button) it.button.pop = k;
    else if (it.view) it.view.pop = k;
    else if (it.tile) it.tile.pop = k;
    else {
      it.obj.scale.setScalar(Math.max(0.0001, k));
      it.obj.visible = k > 0.001;
    }
  }
  runIntro(now) {
    const intro = this.intro;
    if (!intro) return;
    for (const it of intro.items) {
      const t = clamp((now - it.at) / 380, 0, 1);
      if (t > 0 && !it.sounded) {
        it.sounded = true;
        if (it.slot !== intro.lastSlot) {
          intro.lastSlot = it.slot;
          sfx('spawn', { pitch: 0.8 + (it.slot / Math.max(1, intro.slots)) * 0.9 });
        }
      }
      this.setPop(it, t <= 0 ? 0 : ease.outBack(t));
    }
    if (now > intro.end) {
      for (const it of intro.items) this.setPop(it, 1);
      this.intro = null;
    }
  }

  // ---- per frame -----------------------------------------------------------

  update(dt, now) {
    const ed = this.editor;
    const { halfW, R, D } = LAY;

    // pills are clipped where the film enters the spools
    this.bench.updateWorldMatrix(true, false);
    this.clipPlanes[0].set(_v.set(1, 0, 0), halfW).applyMatrix4(this.bench.matrixWorld);
    this.clipPlanes[1].set(_v.set(-1, 0, 0), halfW).applyMatrix4(this.bench.matrixWorld);

    // ---- pills
    const mpf = this.mPerFrame;
    const seen = new Set();
    const sel = ed.project.selected;
    const trim = ed.trim;
    const state = { now, hotIn: false, hotOut: false, limitIn: false, limitOut: false, merge: 0 };
    const show = (clip, track, heldEntry) => {
      let v = this.pills.get(clip.id);
      if (!v) {
        v = this.viewFor(clip);
        if (this.pendingKick?.id === clip.id) {
          v.kickV = this.pendingKick.v;
          v.squashV = -4;
          this.pendingKick = null;
        }
        if (this.pendingPop === clip.id) {
          v.pop = 0.2;
          v.squashV = 7;
          this.pendingPop = null;
        } else if (this.intro) v.pop = 0;
      }
      seen.add(clip.id);
      if (!this.intro && v.pop < 1) v.pop = Math.min(1, v.pop + dt * 6);
      const len = clipLen(clip);
      const live = (trim && trim.id === clip.id) || v.fresh || heldEntry;
      // other pills ease to where the edit puts them; the one in hand is exact
      v.dispAt = live ? clip.at : damp(v.dispAt, clip.at, 22, dt);
      v.dispLen = live ? len : damp(v.dispLen, len, 22, dt);
      if (Math.abs(v.dispAt - clip.at) < 0.02) v.dispAt = clip.at;
      if (Math.abs(v.dispLen - len) < 0.02) v.dispLen = len;
      v.track = track;
      v.selected = clip.id === sel;
      state.hotIn = this.hot.id === clip.id && this.hot.edge === 'in';
      state.hotOut = this.hot.id === clip.id && this.hot.edge === 'out';
      state.limitIn = !!trim && trim.id === clip.id && trim.edge === 'in' && !!trim.limit;
      state.limitOut = !!trim && trim.id === clip.id && trim.edge === 'out' && !!trim.limit;
      state.merge = heldEntry && this.mergeFx ? this.mergeFx.progress : 0;
      const lenM = Math.max(0.004, v.dispLen * mpf);
      const x0 = (v.dispAt - ed.time) * mpf;
      const off = !heldEntry && (x0 > halfW + 0.03 || x0 + lenM < -halfW - 0.03);
      v.group.visible = !off;
      if (heldEntry) v.lenM = lenM;
      v.place(clip, x0, lenM, laneY(track), dt, state);
    };
    for (let t = 0; t < 3; t++) {
      const lane = ed.drop && ed.drop.track === t ? ed.drop.lane : ed.project.tracks[t];
      for (const clip of lane) {
        if (ed.held.has(clip.id)) continue; // the landing spot is drawn as a ghost instead
        show(clip, t, null);
      }
    }
    for (const h of ed.held.values()) {
      const v = this.pills.get(h.clip.id);
      show(h.clip, v ? v.track : h.fromTrack, h);
    }
    for (const [id, v] of this.pills) {
      if (seen.has(id)) continue;
      v.dying += dt * 7;
      if (v.dying >= 1) {
        v.dispose();
        this.pills.delete(id);
      } else {
        v.inner.scale.setScalar(Math.max(0.0001, 1 - v.dying));
      }
    }

    // ---- landing ghost
    if (ed.drop) {
      const lenM = ed.drop.len * mpf;
      const visLen = Math.max(0.006, lenM - 0.003);
      this.ghost.visible = true;
      this.ghostMat.userData.stretch.value = Math.max(0, visLen / 2 - R);
      this.ghost.scale.x = visLen < 2 * R ? visLen / (2 * R) : 1;
      this.ghost.position.set((ed.drop.at - ed.time) * mpf + lenM / 2, laneY(ed.drop.track), 0);
    } else this.ghost.visible = false;

    // ---- cut line, blade, slash
    const canCut = !ed.cutBlocker() && !ed.playing && !ed.held.size && !ed.trim;
    const selView = this.pills.get(sel);
    this.blade.visible = canCut && !!selView;
    if (this.blade.visible) {
      this.blade.position.y = selView.y;
      const pulse = 0.75 + 0.25 * Math.sin(now * 0.008);
      this.blade.material.opacity = 0.55 + 0.45 * Math.max(pulse * 0.6, this.armedK || 0);
      this.blade.scale.set(1 + (this.armedK || 0) * 1.4, 1, 1);
    }
    this.armedK = damp(this.armedK || 0, canCut ? this.armed : 0, 14, dt);
    this.beam.visible = this.armedK > 0.03 && !!selView;
    if (this.beam.visible) {
      this.beam.position.y = selView.y;
      this.beam.material.opacity = this.armedK * 0.55;
    }
    if (this.slashT > 0) {
      this.slashT = Math.max(0, this.slashT - dt * 5.5);
      this.slash.visible = this.slashT > 0;
      this.slash.material.opacity = this.slashT;
      this.slash.scale.set(1 + (1 - this.slashT) * 3, 0.4 + (1 - this.slashT) * 1.2, 1);
    }

    // ---- merge ring
    if (this.mergeFx) {
      this.ring.visible = this.ringFill.visible = true;
      this.ring.position.copy(this.mergeFx.point);
      this.ringFill.position.copy(this.mergeFx.point);
      this.ring.position.z += 0.02;
      this.ringFill.position.z += 0.02;
      this.ringFill.scale.setScalar(Math.max(0.001, this.mergeFx.progress));
      this.ring.scale.setScalar(1 + 0.08 * Math.sin(now * 0.02));
    } else this.ring.visible = this.ringFill.visible = false;

    // ---- hint line and the tag that follows a trim
    let hint = '';
    let dim = false;
    if (now < this.noticeUntil) hint = this.noticeText;
    else if (this.exportState.busy) hint = 'Exporting… ' + Math.round(this.exportState.progress * 100) + '%';
    else if (this.mergeFx) hint = this.mergeFx.progress > 0 ? 'Hold them together…' : 'Touch the two pills together to merge';
    else if (ed.trim) hint = ed.trim.limit === 'start' ? 'That is the start of the recording' : ed.trim.limit === 'end' ? 'That is the end of the recording' : ed.trim.limit ? 'It cannot get shorter than this' : 'Let go to keep this length';
    else if (ed.held.size) hint = ed.drop ? 'Let go to drop it here' : 'Carry it to a track';
    else {
      dim = true;
      if (!ed.duration()) hint = 'Tap a recording in the library to begin';
      else if (!sel) hint = 'Tap a pill to select it';
      else if (canCut) hint = 'Chop your open hand down through the pill to cut at the line';
      else hint = 'Swipe the belt to slide the film under the line';
    }
    this.hint.set(hint, dim ? '#9da3cf' : '#ffffff');
    if (ed.trim && selView) {
      const d = ed.trim.len - ed.trim.baseLen;
      this.tag.mesh.visible = true;
      this.tag.set(seconds(ed.trim.len) + (d ? '  ' + (d > 0 ? '+' : '−') + seconds(Math.abs(d)) : ''), ed.trim.limit ? '#ff9a9a' : '#ffffff');
      const ex = ed.trim.edge === 'in' ? selView.x - selView.lenM / 2 : selView.x + selView.lenM / 2;
      this.tag.mesh.position.set(clamp(ex, -halfW + 0.05, halfW - 0.05), selView.y + R + 0.02, D + 0.02);
    } else this.tag.mesh.visible = false;

    // ---- console
    const d = ed.duration();
    this.dial.position.x = this.dialX();
    const beltSeconds = (LAY.belt.halfW * 2) / ed.scale;
    this.beltTex.repeat.set(beltSeconds, 1);
    this.beltTex.offset.set(ed.time / FPS - beltSeconds / 2, 0);
    this.clock.set(timecode(ed.time) + '  /  ' + timecode(d));
    this.playBtn.setFace({ icon: ed.playing ? Pause : Play });
    if (this.mapRev !== ed.revision) {
      this.mapRev = ed.revision;
      this.drawMap();
    }

    // ---- keys
    const k = this.keys;
    k.undo.enabled = ed.undoStack.length > 0;
    k.redo.enabled = ed.redoStack.length > 0;
    k.remove.enabled = !!sel;
    k.mute.enabled = !!sel;
    const selClip = ed.selection();
    k.mute.setFace({ icon: selClip?.muted ? VolumeX : Volume2, label: selClip?.muted ? 'Muted' : 'Sound' });
    k.ratio.setFace({ icon: ed.project.ratio === '9:16' ? RectangleVertical : RectangleHorizontal, label: ed.project.ratio });
    const ex = this.exportState;
    k.export.setFace(ex.busy ? { icon: X, label: Math.round(ex.progress * 100) + '%' } : ex.ready ? { icon: Check, label: 'Save' } : { icon: Upload, label: 'Export' });
    for (const b of this.buttons) b.animate(dt);

    // ---- library shelf
    const { pitch, rows } = LAY.lib;
    const max = this.maxLibScroll();
    if (!this.libTouching) {
      this.libScroll += this.libVel * dt;
      this.libVel *= Math.exp(-dt * 3.2);
      if (Math.abs(this.libVel) < 0.02) this.libVel = 0;
      if (this.libScroll < 0) this.libScroll = damp(this.libScroll, 0, 14, dt);
      if (this.libScroll > max) this.libScroll = damp(this.libScroll, max, 14, dt);
    }
    this.libScroll = clamp(this.libScroll, -0.6, max + 0.6);
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      const slot = i - this.libScroll; // 0 is the top row
      t.y = ((rows - 1) / 2 - slot) * pitch;
      const edge = Math.min(slot + 0.9, rows - 0.1 - slot);
      t.scale = clamp(edge / 0.7, 0, 1);
      if (!this.intro && t.pop < 1) t.pop = Math.min(1, t.pop + dt * 5);
      t.press = damp(t.press, 0, 10, dt);
      const s = t.scale * t.pop;
      t.group.visible = s > 0.02;
      t.group.position.set(0, t.y, -t.press * 0.008);
      t.inner.scale.setScalar(Math.max(0.0001, s));
      if (t.win) syncStrip(t.win, t.src);
    }
    const span = rows * pitch - 0.05;
    this.libThumb.visible = max > 0;
    this.libThumb.position.y = span / 2 - (max ? clamp(this.libScroll / max, 0, 1) : 0) * span;

    // ---- the screen
    this.ratioK = damp(this.ratioK, ed.project.ratio === '9:16' ? 0 : 1, 9, dt);
    const [tw, th] = LAY.screen.tall;
    const [ww, wh] = LAY.screen.wide;
    const W = tw + (ww - tw) * this.ratioK;
    const H = th + (wh - th) * this.ratioK;
    this.screenBack.scale.set(W + 0.1, H + 0.1, 1);
    this.black.scale.set(W, H, 1);
    this.halo.scale.set(W * 2.4, H * 1.9, 1);
    const bands = this.player.bands;
    const n = bands.length;
    for (let i = 0; i < 3; i++) {
      const mesh = this.bandMeshes[i];
      const band = bands[i];
      if (!band) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = band.ready;
      const bh = H / n;
      mesh.scale.set(W, bh, 1);
      mesh.position.set(0, H / 2 - (i + 0.5) * bh, 0);
      if (mesh.material.map !== band.tex) {
        mesh.material.map = band.tex;
        mesh.material.needsUpdate = true;
      }
      const bandAspect = W / bh;
      const srcAspect = band.w / Math.max(1, band.h);
      if (srcAspect > bandAspect) {
        const rx = bandAspect / srcAspect;
        band.tex.repeat.set(rx, 1);
        band.tex.offset.set((1 - rx) / 2, 0);
      } else {
        const ry = srcAspect / bandAspect;
        band.tex.repeat.set(1, ry);
        band.tex.offset.set(0, (1 - ry) / 2);
      }
    }
    const empty = n === 0;
    this.idle.mesh.visible = this.idleSub.mesh.visible = empty && !ed.playing;
    this.idleSub.set(d ? 'Nothing under the line here' : 'Bring a recording to a track');
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt * 6);
      this.flash.visible = this.flashT > 0;
      this.flash.scale.set(W, H, 1);
      this.flash.material.opacity = this.flashT * 0.22;
    }
    this.progress.visible = ex.busy;
    if (ex.busy) {
      this.progress.scale.set(Math.max(0.001, W * ex.progress), 0.03, 1);
      this.progress.position.set(-W / 2 + (W * ex.progress) / 2, -H / 2 + 0.03, 0.006);
    }

    this.sparks.update(dt);
    this.runIntro(now);
  }

  drawMap() {
    const ed = this.editor;
    const g = this.mapCanvas.getContext('2d');
    const { width: w, height: h } = this.mapCanvas;
    g.clearRect(0, 0, w, h);
    const d = Math.max(1, ed.duration());
    for (let t = 0; t < 3; t++) {
      const y = h - (t + 1) * (h / 3) + 1;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, y, w, h / 3 - 2);
      for (const c of ed.project.tracks[t]) {
        const src = this.library.get(c.segs[0].src);
        g.fillStyle = src?.color || '#888';
        g.globalAlpha = c.id === ed.project.selected ? 1 : 0.8;
        g.fillRect((c.at / d) * w + 1, y, Math.max(2, (clipLen(c) / d) * w - 2), h / 3 - 2);
      }
      g.globalAlpha = 1;
    }
    this.mapTex.needsUpdate = true;
  }
}

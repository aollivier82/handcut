// Hand tracking: reads the 25 WebXR joints of each hand every frame, works
// out what the hand is doing (pinching, pointing, open and edge-on for a
// chop) and draws a translucent glove exactly where the joints are, so what
// the editor sees is what touches the pills.
//
// Meta's IWSDK input manager tracks the input sources and its pinch state is
// used alongside the measured thumb-to-index distance.

import * as THREE from 'three';
import { XRInputManager } from '@iwsdk/xr-input';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const JOINTS = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];
const WRIST = 0, THUMB_TIP = 4, INDEX_PROX = 6, INDEX_TIP = 9, MIDDLE_META = 10, PINKY_PROX = 21;
const FINGERS = [[6, 9], [11, 14], [16, 19], [21, 24]]; // proximal knuckle, tip
const BLADE = [24, 22, 21, 20]; // little-finger edge of the hand, tip to palm
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8], [8, 9],
  [0, 10], [10, 11], [11, 12], [12, 13], [13, 14],
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19],
  [0, 20], [20, 21], [21, 22], [22, 23], [23, 24],
  [6, 11], [11, 16], [16, 21], [5, 10], [10, 15], [15, 20], [1, 5],
];
const PINCH_ON = 0.019;
const PINCH_OFF = 0.034;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function gloveMaterial(color, rim) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uRim: { value: new THREE.Color(rim) }, uGlow: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        mat4 im = mat4(1.0);
        #ifdef USE_INSTANCING
          im = instanceMatrix;
        #endif
        vec4 mv = modelViewMatrix * im * vec4(position, 1.0);
        vN = normalize(normalMatrix * mat3(im) * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform vec3 uRim; uniform float uGlow;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        f = f * f;
        vec3 c = mix(uColor, uRim, f) + uRim * uGlow * 0.35;
        gl_FragColor = vec4(c, mix(0.34, 0.96, f));
      }`,
    transparent: true,
    depthWrite: true,
  });
}

export class HandState {
  constructor(side) {
    this.side = side;
    this.tracked = false;
    this.lostFor = 9999;
    this.world = JOINTS.map(() => new THREE.Vector3());
    this.local = JOINTS.map(() => new THREE.Vector3());
    this.radii = new Float32Array(JOINTS.length).fill(0.008);
    this.mats = new Float32Array(16 * JOINTS.length);
    this.spaces = null;
    this.xrHand = null;
    this.tip = this.local[INDEX_TIP];
    this.tipPrev = new THREE.Vector3();
    this.hasPrev = false;
    this.tipRadius = 0.008;
    this.pinch = new THREE.Vector3(); // smoothed, workspace space
    this.pinchWorld = new THREE.Vector3();
    this.pinchGap = 1;
    this.pinching = false;
    this.pinchStarted = false;
    this.pinchEnded = false;
    this.sdkPinch = false;
    this.palm = new THREE.Vector3();
    this.palmPrev = new THREE.Vector3();
    this.palmNormal = new THREE.Vector3(0, 1, 0);
    this.vel = new THREE.Vector3();
    this.speed = 0;
    this.extended = 0;
    this.open = false;
    this.pointing = false;
    this.blade = BLADE.map(() => new THREE.Vector3());
    this.drag = null; // owned by the stage
    this.mute = false; // ignore this pinch until it is released
    this.memo = {}; // per-hand scratch for the stage (touch states, chop history)
  }
}

export class Hands {
  constructor(scene, camera) {
    this.left = new HandState('left');
    this.right = new HandState('right');
    this.list = [this.left, this.right];
    this.any = false;
    this.group = new THREE.Group();
    this.group.name = 'hands';
    scene.add(this.group);

    const sphere = new THREE.SphereGeometry(1, 12, 9);
    const tube = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    for (const h of this.list) {
      const mat = gloveMaterial(h.side === 'left' ? 0x2a8f86 : 0x2a8f86, 0xd8fff6);
      h.mat = mat;
      h.jointMesh = new THREE.InstancedMesh(sphere, mat, JOINTS.length);
      h.boneMesh = new THREE.InstancedMesh(tube, mat, BONES.length);
      for (const m of [h.jointMesh, h.boneMesh]) {
        m.frustumCulled = false;
        m.renderOrder = 50;
        m.visible = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(m);
      }
      h.dot = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      h.dot.renderOrder = 51;
      h.dot.visible = false;
      h.pinchDot = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
      h.pinchDot.renderOrder = 51;
      h.pinchDot.visible = false;
      this.group.add(h.dot, h.pinchDot);
    }

    // IWSDK input layer (optional at runtime: raw WebXR joints still work without it).
    this.sdk = null;
    try {
      const loader = new GLTFLoader();
      this.sdk = new XRInputManager({
        scene,
        camera,
        pointerSettings: { enabled: false },
        assetLoader: { loadGLTF: (path) => loader.loadAsync(/hand/i.test(path) ? './hands/' + (/left/i.test(path) ? 'left' : 'right') + '.glb' : path) },
      });
      scene.add(this.sdk.xrOrigin);
    } catch (e) {
      console.warn('IWSDK input unavailable, using raw WebXR hands', e);
      this.sdk = null;
    }
  }

  hide() {
    for (const h of this.list) {
      h.tracked = false;
      h.lostFor = 9999;
      h.pinching = h.pinchStarted = h.pinchEnded = false;
      h.hasPrev = false;
      h.jointMesh.visible = h.boneMesh.visible = h.dot.visible = h.pinchDot.visible = false;
    }
    this.any = false;
  }

  /** rigInverse: world -> workspace matrix. dt in seconds. */
  update(renderer, frame, rigInverse, dt, now) {
    const session = renderer.xr.getSession();
    const space = renderer.xr.getReferenceSpace();
    if (!session || !space || !frame) return;
    if (this.sdk) {
      try {
        this.sdk.update(renderer.xr, dt, now);
        for (const side of ['left', 'right']) {
          const vis = this.sdk.visualAdapters?.hand?.[side]?.visual?.model;
          if (vis) vis.visible = false; // Handcut draws its own gloves from the same joints
          const cv = this.sdk.visualAdapters?.controller?.[side]?.visual?.model;
          if (cv) cv.visible = false;
        }
      } catch (e) {
        console.warn('IWSDK input update failed; continuing with raw WebXR hands', e);
        this.sdk = null;
      }
    }
    let any = false;
    for (const h of this.list) {
      let src = null;
      for (const s of session.inputSources) if (s.hand && s.handedness === h.side) src = s;
      const was = h.pinching;
      let ok = false;
      if (src) {
        if (h.xrHand !== src.hand) {
          h.xrHand = src.hand;
          h.spaces = JOINTS.map((n) => src.hand.get(n));
        }
        try {
          if (frame.fillPoses && h.spaces.every(Boolean)) {
            ok = frame.fillPoses(h.spaces, space, h.mats);
            if (ok) {
              for (let i = 0; i < JOINTS.length; i++) h.world[i].fromArray(h.mats, i * 16 + 12);
              frame.fillJointRadii?.(h.spaces, h.radii);
            }
          }
          if (!ok) {
            ok = true;
            for (let i = 0; i < JOINTS.length; i++) {
              const pose = h.spaces[i] && frame.getJointPose(h.spaces[i], space);
              if (!pose) {
                if (i === WRIST || i === INDEX_TIP || i === THUMB_TIP) ok = false;
                continue;
              }
              const p = pose.transform.position;
              h.world[i].set(p.x, p.y, p.z);
              if (pose.radius) h.radii[i] = pose.radius;
            }
          }
        } catch {
          ok = false;
        }
        const w = h.world[INDEX_TIP];
        if (!Number.isFinite(w.x + w.y + w.z) || !Number.isFinite(h.world[WRIST].x)) ok = false;
      }

      h.pinchStarted = h.pinchEnded = false;
      if (!ok) {
        h.tracked = false;
        h.lostFor += dt * 1000;
        h.hasPrev = false;
        h.jointMesh.visible = h.boneMesh.visible = h.dot.visible = h.pinchDot.visible = false;
        if (h.lostFor > 260 && h.pinching) {
          h.pinching = false;
          h.pinchEnded = true;
        }
        continue;
      }
      any = true;
      const fresh = !h.tracked;
      h.tracked = true;
      h.lostFor = 0;
      h.tipPrev.copy(h.tip);
      for (let i = 0; i < JOINTS.length; i++) h.local[i].copy(h.world[i]).applyMatrix4(rigInverse);
      h.hasPrev = !fresh;
      if (fresh) h.tipPrev.copy(h.tip);
      const r = h.radii[INDEX_TIP];
      h.tipRadius = r > 0.003 && r < 0.02 ? r : 0.008;

      // palm, speed
      h.palm.copy(h.local[WRIST]).lerp(h.local[MIDDLE_META + 1], 0.55);
      if (fresh) h.palmPrev.copy(h.palm);
      _a.copy(h.palm).sub(h.palmPrev).divideScalar(Math.max(0.004, dt));
      h.vel.lerp(_a, 0.5);
      h.speed = h.vel.length();
      h.palmPrev.copy(h.palm);
      _a.copy(h.local[INDEX_PROX]).sub(h.local[WRIST]);
      _b.copy(h.local[PINKY_PROX]).sub(h.local[WRIST]);
      h.palmNormal.crossVectors(_a, _b).normalize();

      // fingers
      let ext = 0;
      const wrist = h.local[WRIST];
      const flags = [];
      for (const [k, t] of FINGERS) {
        const e = h.local[t].distanceTo(wrist) > h.local[k].distanceTo(wrist) * 1.32;
        flags.push(e);
        if (e) ext++;
      }
      h.extended = ext;
      for (let i = 0; i < BLADE.length; i++) h.blade[i].copy(h.local[BLADE[i]]);

      // pinch: measured gap with hysteresis, or the SDK's own pinch state
      h.pinchGap = h.world[INDEX_TIP].distanceTo(h.world[THUMB_TIP]);
      let sdk = false;
      if (this.sdk) {
        try {
          sdk = this.sdk.getPrimaryInputSource(h.side) === src && !!this.sdk.getSelectState(h.side)?.active;
        } catch {
          sdk = false;
        }
      }
      h.sdkPinch = sdk;
      const geo = h.pinchGap < (was ? PINCH_OFF : PINCH_ON);
      h.pinching = geo || (sdk && h.pinchGap < 0.05);
      h.pinchStarted = h.pinching && !was;
      h.pinchEnded = !h.pinching && was;
      h.open = ext >= 3 && !h.pinching && h.pinchGap > 0.04;
      h.pointing = flags[0] && ext <= 2 && !h.pinching;

      h.pinchWorld.copy(h.world[INDEX_TIP]).lerp(h.world[THUMB_TIP], 0.5);
      _a.copy(h.pinchWorld).applyMatrix4(rigInverse);
      if (fresh || h.pinchStarted) h.pinch.copy(_a);
      else h.pinch.lerp(_a, 1 - Math.exp(-dt * (16 + 70 * Math.min(1, h.speed / 0.45))));

      // glove
      for (let i = 0; i < JOINTS.length; i++) {
        const rad = Math.min(0.024, Math.max(0.0055, h.radii[i] || 0.008));
        _s.setScalar(rad);
        _m.compose(h.world[i], _q.identity(), _s);
        h.jointMesh.setMatrixAt(i, _m);
      }
      for (let i = 0; i < BONES.length; i++) {
        const [ia, ib] = BONES[i];
        const pa = h.world[ia];
        const pb = h.world[ib];
        _a.copy(pb).sub(pa);
        const len = _a.length();
        const rad = Math.min(0.022, Math.max(0.005, Math.min(h.radii[ia] || 0.008, h.radii[ib] || 0.008)));
        if (len < 1e-5) _q.identity();
        else _q.setFromUnitVectors(_up, _a.divideScalar(len));
        _b.copy(pa).lerp(pb, 0.5);
        _s.set(rad, len, rad);
        _m.compose(_b, _q, _s);
        h.boneMesh.setMatrixAt(i, _m);
      }
      h.jointMesh.instanceMatrix.needsUpdate = true;
      h.boneMesh.instanceMatrix.needsUpdate = true;
      h.jointMesh.visible = h.boneMesh.visible = true;
      h.dot.visible = true;
      h.dot.position.copy(h.world[INDEX_TIP]);
      h.pinchDot.visible = h.pinching;
      h.pinchDot.position.copy(h.pinchWorld);
      h.mat.uniforms.uGlow.value += ((h.pinching ? 1 : 0) - h.mat.uniforms.uGlow.value) * Math.min(1, dt * 14);
    }
    this.any = any;
  }
}

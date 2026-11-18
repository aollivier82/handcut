// Handcut: a video editor you operate with your bare hands on Meta Quest 3.
// This file is the shell: renderer, the VR session, arrival placement, and
// the trips out of VR that the headset requires (picking files, saving).

import '@fontsource-variable/dm-sans';
import './style.css';
import * as THREE from 'three';
import { Library } from './media.js';
import { Editor } from './editor.js';
import { Player } from './player.js';
import { Hands } from './hands.js';
import { Stage } from './stage.js';
import { Interact } from './interact.js';
import { primeAudio, sfx } from './sfx.js';
import { FPS, flatten } from './model.js';

const $ = (id) => document.getElementById(id);
const DESK_KEY = 'handcut-desk-offset';

async function boot() {
  const host = $('stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  renderer.xr.setFramebufferScaleFactor(1.15);
  renderer.xr.setFoveation(0.5);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060c);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.02, 120);

  try {
    await Promise.race([
      Promise.all([document.fonts.load('650 44px "DM Sans Variable"'), document.fonts.load('750 44px "DM Sans Variable"')]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {}

  const library = new Library();
  await library.init();
  const editor = new Editor(library);
  editor.load();
  const player = new Player(editor, library);
  const hands = new Hands(scene, camera);

  let session = null;
  let placed = false;
  let steady = null;
  let anchor = null;
  let handoff = '';
  let exportJob = null;
  let result = null;
  let lastHands = 0;
  let nagAt = 0;
  const deskOffset = new THREE.Vector3();
  try {
    const saved = JSON.parse(localStorage.getItem(DESK_KEY));
    if (Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite)) deskOffset.fromArray(saved);
  } catch {}

  const app = {
    inXR: () => !!session,
    gesture() {
      primeAudio();
      player.prime();
    },
    importVideos() {
      if (session) {
        handoff = 'import';
        session.end();
      } else $('files').click();
    },
    exportVideo: () => exportVideo(),
    recenter() {
      if (!session) return;
      placed = false;
      steady = null;
      stage.rig.visible = false;
      hands.hide();
    },
    exitVR: () => session?.end(),
    deskMoved() {
      if (!anchor) return;
      deskOffset.copy(stage.rig.position).sub(anchor.head).applyAxisAngle(new THREE.Vector3(0, 1, 0), -anchor.yaw);
      deskOffset.clampLength(0, 0.7);
      try {
        localStorage.setItem(DESK_KEY, JSON.stringify(deskOffset.toArray()));
      } catch {}
    },
  };

  const stage = new Stage(scene, editor, library, player, app);
  const interact = new Interact({ stage, editor, hands, library, player, app, camera, canvas: renderer.domElement });
  stage.startIntro(performance.now(), true);

  // ---- computer preview camera --------------------------------------------
  function resize() {
    if (session) return;
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    camera.fov = aspect >= 1.6 ? 70 : Math.min(112, (70 * 1.6) / aspect);
    camera.position.set(0, 0.06, 0.42);
    camera.lookAt(0, 0.06 - 0.072, -0.58);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  // ---- toasts and the card shown outside VR --------------------------------
  let toastTimer = 0;
  function toast(text, ms = 2600) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }
  function card(kind, info = {}) {
    const el = $('card');
    const canVR = !!navigator.xr;
    const back = `<button class="ghost" data-act="vr">${canVR ? 'Back to VR' : 'Close'}</button>`;
    let html = '';
    if (kind === 'import') {
      html = `<h2>Bring in your recordings</h2><p>Pick videos from this headset's gallery. They are added to the library shelf on your left.</p>
        <div class="row"><button class="primary" data-act="pick">Choose videos</button>${back}</div>`;
    } else if (kind === 'imported') {
      html = `<h2>${info.title}</h2><p>${info.text}</p><div class="row"><button class="primary" data-act="vr">${canVR ? 'Back to VR' : 'Done'}</button><button class="ghost" data-act="pick">Choose more</button></div>`;
    } else if (kind === 'save' && result) {
      html = `<h2>Your video is ready</h2><video controls playsinline src="${result.url}"></video>
        <p>${result.width} × ${result.height} · ${(result.frames / FPS).toFixed(1)} s · ${result.ext.toUpperCase()} · ${(result.blob.size / 1e6).toFixed(1)} MB</p>
        <div class="row"><a class="primary" download="handcut-${Date.now().toString(36)}.${result.ext}" href="${result.url}">Save video</a>
        <a class="ghost" target="_blank" rel="noopener" href="https://www.tiktok.com/upload">Open TikTok upload</a>${back}</div>
        <p class="fine">Save the video first, then choose it on TikTok's upload page.</p>`;
    } else {
      el.hidden = true;
      return;
    }
    el.innerHTML = html;
    el.hidden = false;
  }
  $('card').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'pick') $('files').click();
    else if (act === 'vr') {
      $('card').hidden = true;
      if (navigator.xr) enterVR();
    }
  });

  $('files').addEventListener('change', async () => {
    const files = [...$('files').files];
    $('files').value = '';
    if (!files.length) return;
    toast('Reading ' + files.length + (files.length === 1 ? ' video…' : ' videos…'), 20000);
    const r = await library.importFiles(files);
    const n = r.added.length;
    stage.libScroll = stage.maxLibScroll();
    let text = n ? 'They are on the library shelf. Tap one to add it, or pinch it and carry it to a track.' : '';
    if (r.sessionOnly) text += ' This headset is short on storage, so ' + (r.sessionOnly === 1 ? 'one of them' : r.sessionOnly + ' of them') + ' will need importing again next time.';
    if (r.failed.length) text += ' Could not read: ' + r.failed.join('; ');
    toast(n + (n === 1 ? ' recording added' : ' recordings added'));
    card('imported', { title: n ? n + (n === 1 ? ' recording added' : ' recordings added') : 'Nothing was added', text });
    if (n) sfx('pop');
  });

  // ---- export -----------------------------------------------------------------
  const signature = () => JSON.stringify([flatten(editor.project).map((t) => t.map((s) => [s.at, s.len, s.src, s.in, s.muted])), editor.project.ratio]);
  let checkedRev = -1;
  async function exportVideo() {
    if (exportJob) {
      exportJob.abort();
      return;
    }
    if (result && stage.exportState.ready) {
      if (session) {
        handoff = 'save';
        session.end();
      } else card('save');
      return;
    }
    if (!editor.duration()) {
      stage.deny('Add a recording first');
      return;
    }
    editor.stop();
    const ctl = new AbortController();
    exportJob = ctl;
    const sig = signature();
    stage.exportState = { busy: true, progress: 0, ready: false };
    player.suspend();
    try {
      const { exportProject } = await import('./export.js');
      const out = await exportProject({
        tracks: flatten(editor.project),
        totalFrames: editor.duration(),
        ratio: editor.project.ratio,
        fps: FPS,
        getBlob: (id) => library.blobFor(id),
        onProgress: (f) => {
          stage.exportState.progress = f;
        },
        signal: ctl.signal,
      });
      if (result) URL.revokeObjectURL(result.url);
      result = { ...out, url: URL.createObjectURL(out.blob), sig };
      const fresh = sig === signature();
      stage.exportState = { busy: false, progress: 1, ready: fresh };
      sfx('done');
      stage.notice(fresh ? 'Video ready. Press Save to leave VR and keep it' : 'The edit changed. Export again', 5000);
      if (!session) card('save');
    } catch (e) {
      stage.exportState = { busy: false, progress: 0, ready: false };
      if (ctl.signal.aborted) stage.notice('Export cancelled', 1500);
      else {
        console.error(e);
        stage.notice('Export failed: ' + (e?.message || e), 7000);
        toast('Export failed: ' + (e?.message || e), 7000);
        sfx('denied');
      }
    } finally {
      exportJob = null;
      player.resume();
    }
  }

  // ---- the VR session -----------------------------------------------------------
  async function enterVR() {
    if (session) return;
    app.gesture();
    if (!navigator.xr) {
      toast('Open this page in the Meta Quest browser to enter VR', 5000);
      return;
    }
    try {
      const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['hand-tracking', 'local-floor'] });
      session = s;
      placed = false;
      steady = null;
      stage.rig.visible = false;
      hands.hide();
      $('card').hidden = true;
      document.body.classList.add('in-vr');
      s.addEventListener('end', () => {
        session = null;
        placed = false;
        anchor = null;
        for (const h of hands.list) {
          if (h.drag) {
            h.drag.cancel();
            h.drag = null;
          }
        }
        hands.hide();
        editor.stop();
        player.stopAll();
        editor.persist();
        stage.rig.position.set(0, 0, 0);
        stage.rig.rotation.set(0, 0, 0);
        stage.rig.visible = true;
        stage.startIntro(performance.now(), true);
        document.body.classList.remove('in-vr');
        requestAnimationFrame(resize);
        if (handoff === 'import') card('import');
        else if (handoff === 'save') card('save');
        handoff = '';
      });
      await renderer.xr.setSession(s);
    } catch (e) {
      session = null;
      document.body.classList.remove('in-vr');
      stage.rig.visible = true;
      toast(e?.message || 'VR could not start', 5000);
    }
  }

  const _f = new THREE.Vector3();
  const _h = new THREE.Vector3();
  const _o = new THREE.Vector3();
  /** Wait for the head to hold still for a moment, then build the desk around it. */
  function arrive(pose, now) {
    const p = pose.transform.position;
    const q = pose.transform.orientation;
    _h.set(p.x, p.y, p.z);
    _f.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    _f.y = 0;
    if (_f.lengthSq() < 1e-4) _f.set(0, 0, -1);
    _f.normalize();
    if (!steady) steady = { head: _h.clone(), fwd: _f.clone(), since: now, first: now };
    if (_h.distanceTo(steady.head) > 0.04 || _f.dot(steady.fwd) < 0.992) {
      steady.head.copy(_h);
      steady.fwd.copy(_f);
      steady.since = now;
    }
    if (now - steady.since < 260 && now - steady.first < 1400) return;
    const yaw = Math.atan2(-_f.x, -_f.z);
    anchor = { head: _h.clone(), yaw };
    stage.rig.rotation.set(0, yaw, 0);
    _o.copy(deskOffset).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    stage.rig.position.copy(_h).add(_o);
    stage.rig.visible = true;
    stage.rig.updateMatrixWorld(true);
    placed = true;
    lastHands = now;
    stage.startIntro(now);
    stage.notice('Look down for Play. Tap, pinch and chop with your hands', 5200);
  }

  // ---- 2D page buttons and keys ---------------------------------------------------
  $('btn-vr').addEventListener('click', enterVR);
  $('btn-import').addEventListener('click', () => {
    app.gesture();
    $('files').click();
  });
  $('btn-export').addEventListener('click', () => {
    app.gesture();
    exportVideo();
  });
  if (navigator.xr?.isSessionSupported) {
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
      document.body.classList.toggle('has-vr', !!ok);
      $('btn-vr').textContent = ok ? 'Enter VR' : 'VR needs a headset';
    }).catch(() => {});
  } else $('btn-vr').textContent = 'VR needs a headset';

  window.addEventListener('keydown', (e) => {
    if (session || e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    app.gesture();
    if (mod && k === 'z') (e.shiftKey ? editor.redo() : editor.undo());
    else if (mod && k === 'y') editor.redo();
    else if (mod) return;
    else if (k === ' ') editor.togglePlay();
    else if (k === 's') editor.splitAtPlayhead();
    else if (k === 'delete' || k === 'backspace') editor.deleteSelected();
    else if (k === 'm') editor.toggleMute();
    else if (k === 'arrowleft' || k === 'arrowright') {
      editor.stop();
      editor.seek(editor.time + (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
    } else if (k === '=' || k === '+') editor.zoom(1);
    else if (k === '-') editor.zoom(-1);
    else return;
    e.preventDefault();
  });
  window.addEventListener('pagehide', () => editor.persist());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !session) {
      editor.stop();
      editor.persist();
    }
  });

  // ---- frame loop -----------------------------------------------------------------
  let last = performance.now();
  renderer.setAnimationLoop((_t, frame) => {
    const now = performance.now();
    const real = Math.max(0.001, Math.min(0.25, (now - last) / 1000));
    const dt = Math.min(0.05, real);
    last = now;
    const inXR = !!session && renderer.xr.isPresenting;
    if (inXR && frame) {
      const space = renderer.xr.getReferenceSpace();
      const pose = space && frame.getViewerPose(space);
      if (pose && !placed) arrive(pose, now);
      stage.rig.updateMatrixWorld(true);
      stage.rigInv.copy(stage.rig.matrixWorld).invert();
      if (placed) {
        hands.update(renderer, frame, stage.rigInv, dt, now);
        if (hands.any) lastHands = now;
        else if (now - lastHands > 3500 && now > nagAt) {
          nagAt = now + 7000;
          stage.notice('Put the controllers down: Handcut is worked with your hands', 4000);
        }
      }
    }
    interact.update(dt, now, inXR && placed);
    player.update(real * 1000, now);
    if (checkedRev !== editor.revision) {
      checkedRev = editor.revision;
      if (result && !exportJob) stage.exportState.ready = result.sig === signature();
    }
    stage.update(dt, now);
    renderer.render(scene, camera);
  });

  // handles for automated checks
  window.__handcut = { editor, stage, hands, player, library, interact, renderer, scene, camera, app, enterVR };
  document.body.classList.add('ready');
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('toast');
  if (el) {
    el.textContent = 'Handcut could not start: ' + (e?.message || e);
    el.classList.add('on');
  }
});

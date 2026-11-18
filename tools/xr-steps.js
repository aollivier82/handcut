// Runs inside the page with an emulated Quest 3 (IWER): enters VR, checks the
// desk is built around the head, then works the editor with emulated hands.
const H = window.__handcut;
const d = window.__xr;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { fail: [], notes: [] };
const expect = (name, ok, detail) => { if (!ok) out.fail.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); else out.notes.push('ok ' + name); };
const errs = [];
window.addEventListener('error', (e) => errs.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errs.push('rejection ' + String(e.reason && (e.reason.stack || e.reason))));
const warn = console.warn; console.warn = (...a) => { errs.push('warn ' + a.map(String).join(' ')); warn(...a); };
try {
  d.primaryInputMode = 'hand';
  d.position.set(0.4, 1.52, 0.3);
  const yaw = 0.6;
  d.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  await H.enterVR();
  await sleep(2600);
  const THREE = await import('/node_modules/.vite/deps/three.js').catch(() => null);
  const { stage, editor: ed, hands, renderer } = H;
  expect('session is presenting', renderer.xr.isPresenting);
  expect('desk is visible after arrival', stage.rig.visible);
  const rp = stage.rig.position;
  // the 'local' reference space measures height from where the head started
  expect('desk is built at the head', Math.hypot(rp.x - 0.4, rp.z - 0.3) < 0.75 && Math.abs(rp.y) < 0.75, rp.toArray());
  expect('desk faces the way the head faces', Math.abs(stage.rig.rotation.y - yaw) < 0.05, stage.rig.rotation.y);
  await sleep(900);
  expect('arrival pop-in finished', stage.intro === null && stage.playBtn.pop === 1);

  const V = stage.rig.position.constructor;
  const world = (group, x, y, z) => new V(x, y, z).applyMatrix4(group.matrixWorld);
  const buttonWorld = (b, x, y, z) => new V(x, y, z).applyMatrix4(b.inv.clone().invert()).applyMatrix4(stage.rig.matrixWorld);
  // move an emulated hand so that a joint (9 = index tip) or its pinch point lands on a world position
  async function aim(side, target, what = 'tip') {
    const h = hands[side];
    for (let i = 0; i < 3; i++) {
      const cur = what === 'tip' ? h.world[9] : h.pinchWorld;
      const p = d.hands[side].position;
      p.set(p.x + target.x - cur.x, p.y + target.y - cur.y, p.z + target.z - cur.z);
      await sleep(45);
    }
  }
  d.hands.left.position.set(0.1, 1.2, -0.1);
  d.hands.right.position.set(0.6, 1.2, -0.1);
  await sleep(300);
  expect('both hands are tracked', hands.left.tracked && hands.right.tracked, [hands.left.tracked, hands.right.tracked, hands.any]);
  expect('gloves are drawn', hands.left.jointMesh.visible && hands.right.boneMesh.visible);
  const tipR = hands.right.world[9];
  expect('index tip has a finite position', Number.isFinite(tipR.x + tipR.y + tipR.z), tipR.toArray());
  out.radius = hands.right.tipRadius;
  out.sdk = !!hands.sdk;
  out.extended = [hands.left.extended, hands.right.extended];

  // 1. press Play with the right index fingertip
  const b = stage.playBtn;
  for (let i = 0; i <= 14; i++) await aim('right', buttonWorld(b, 0, 0, 0.09 - (0.078 * i) / 14));
  await sleep(120);
  expect('fingertip presses Play in a real session', ed.playing, { playing: ed.playing, depth: b.depth });
  for (let i = 0; i <= 8; i++) await aim('right', buttonWorld(b, 0, 0, 0.012 + (0.09 * i) / 8));
  for (let i = 0; i <= 14; i++) await aim('right', buttonWorld(b, 0, 0, 0.09 - (0.078 * i) / 14));
  await sleep(120);
  expect('a second press pauses', !ed.playing);
  for (let i = 0; i <= 6; i++) await aim('right', buttonWorld(b, 0, 0, 0.012 + (0.1 * i) / 6));

  // 2. pinch a pill and carry it to track 2
  const clip = ed.project.tracks[0][1];
  const v = stage.pills.get(clip.id);
  const grab = world(stage.bench, v.x, v.y, 0.014);
  // closing the fingers moves the point between them: learn by how much, away from anything grabbable
  const air = world(stage.bench, v.x, v.y + 0.02, 0.3);
  d.hands.right.updatePinchValue(0);
  await aim('right', air, 'pinch');
  await sleep(120);
  const open = new V().copy(hands.right.pinchWorld);
  d.hands.right.updatePinchValue(1);
  await sleep(300);
  const shift = new V().copy(hands.right.pinchWorld).sub(open);
  out.pinchShift = shift.length();
  expect('a pinch in empty air grabs nothing', !hands.right.drag, hands.right.drag && hands.right.drag.kind);
  d.hands.right.updatePinchValue(0);
  await sleep(300);
  await aim('right', new V().copy(grab).sub(shift), 'pinch');
  await sleep(100);
  d.hands.right.updatePinchValue(1);
  await sleep(300);
  expect('pinch is detected', hands.right.pinching, { gap: hands.right.pinchGap, sdk: hands.right.sdkPinch });
  expect('pinch on a pill picks it up', hands.right.drag && hands.right.drag.kind === 'move', hands.right.drag && hands.right.drag.kind);
  const lane2 = world(stage.bench, v.x - 0.05, 0.0, 0.03);
  for (let i = 1; i <= 10; i++) await aim('right', new V().copy(grab).lerp(lane2, i / 10), 'pinch');
  await sleep(120);
  expect('landing ghost shows on track 2', stage.ghost.visible && ed.drop && ed.drop.track === 1, ed.drop && ed.drop.track);
  d.hands.right.updatePinchValue(0);
  await sleep(400);
  expect('releasing the pinch drops the pill on track 2', ed.project.tracks[1].length === 1 && ed.project.tracks[0].length === 1, ed.project.tracks.map((t) => t.length));
  ed.undo();
  await sleep(100);

  // 3. leave VR: the page must recover
  H.app.exitVR();
  await sleep(800);
  expect('leaving VR restores the page', !renderer.xr.isPresenting && stage.rig.visible && stage.rig.position.length() === 0);
} catch (e) {
  out.fail.push('threw ' + (e.stack || e));
}
out.errors = [...new Set(errs)].slice(0, 12);
return out;

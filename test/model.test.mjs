import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, makeClip, appendClip, cut, liftClip, placeClip, moveClip, trimFrom, mergeClips,
  clipLen, clipEnd, duration, flatten, locate, findClip, sanitize, resolvePlacement, snapFrames, MIN_LEN,
} from '../src/model.js';

const SRC = { a: 300, b: 300, c: 240 };
const frames = (id) => SRC[id] || 0;
const spans = (lane) => lane.map((c) => [c.at, clipEnd(c)]);

function packed() {
  const p = createProject();
  const A = makeClip('a', 100); const B = makeClip('b', 100); const C = makeClip('c', 100);
  appendClip(p, A, 0); appendClip(p, B, 0); appendClip(p, C, 0);
  return { p, A, B, C };
}

test('append packs clips end to end', () => {
  const { p } = packed();
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 200], [200, 300]]);
  assert.equal(duration(p), 300);
});

test('cut splits at the frame and keeps the footage continuous', () => {
  const { p, B } = packed();
  const right = cut(p, B.id, 140);
  assert.ok(right);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 140], [140, 200], [200, 300]]);
  assert.deepEqual(B.segs, [{ src: 'b', in: 0, out: 40 }]);
  assert.deepEqual(right.segs, [{ src: 'b', in: 40, out: 100 }]);
  assert.equal(cut(p, B.id, 100), null, 'no cut on the edge');
  assert.equal(cut(p, B.id, 140), null, 'no cut on the other edge');
});

test('lifting a pill closes the hole behind it', () => {
  const { p, A } = packed();
  liftClip(p, A.id);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 200]]);
});

test('lifting leaves a deliberate gap alone', () => {
  const { p, B, C } = packed();
  C.at = 260; // gap after B
  liftClip(p, B.id);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [260, 360]]);
});

test('moving the first pill to the end reorders without a hole', () => {
  const { p, A } = packed();
  moveClip(p, A.id, 0, 200); // the view snaps a drop near 200 to exactly 200
  assert.deepEqual(p.tracks[0].map((c) => c.segs[0].src), ['b', 'c', 'a']);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 200], [200, 300]]);
  moveClip(p, A.id, 0, 260); // a deliberate gap is allowed
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 200], [260, 360]]);
});

test('dropping onto a pill inserts on the nearer side and pushes', () => {
  const { p, C } = packed();
  moveClip(p, C.id, 0, 130); // inside B, left half -> before B
  assert.deepEqual(p.tracks[0].map((c) => c.segs[0].src), ['a', 'c', 'b']);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 200], [200, 300]]);
  assert.deepEqual(resolvePlacement(p.tracks[0], 50, 180), { at: 200, index: 2 });
});

test('moving to another track keeps the requested time', () => {
  const { p, B } = packed();
  moveClip(p, B.id, 1, 37);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 200]]);
  assert.deepEqual(spans(p.tracks[1]), [[37, 137]]);
});

test('right handle: left edge fixed, neighbours pushed and pulled', () => {
  const p = createProject();
  const A = makeClip('a', 300); A.segs[0].out = 100; appendClip(p, A, 0);
  const B = makeClip('b', 100); appendClip(p, B, 0);
  const base = p.tracks[0];
  let r = trimFrom(base, 0, 'out', 50, frames);
  assert.deepEqual(spans(r.lane), [[0, 150], [150, 250]]);
  assert.equal(r.viewShift, 0);
  r = trimFrom(base, 0, 'out', -30, frames);
  assert.deepEqual(spans(r.lane), [[0, 70], [70, 170]]);
  r = trimFrom(base, 0, 'out', 500, frames);
  assert.equal(r.limit, 'end');
  assert.equal(clipLen(r.lane[0]), 300);
  r = trimFrom(base, 0, 'out', -500, frames);
  assert.equal(r.limit, 'min');
  assert.equal(clipLen(r.lane[0]), MIN_LEN);
  assert.deepEqual(spans(base), [[0, 100], [100, 200]], 'base lane untouched');
});

test('left handle with room: only the left edge moves', () => {
  const p = createProject();
  const A = makeClip('a', 300); A.segs[0].in = 100; A.segs[0].out = 200; A.at = 150; p.tracks[0].push(A);
  const B = makeClip('b', 100); B.at = 250; p.tracks[0].push(B);
  let r = trimFrom(p.tracks[0], 0, 'in', 40, frames);
  assert.deepEqual(spans(r.lane), [[190, 250], [250, 350]]);
  assert.equal(r.viewShift, 0);
  r = trimFrom(p.tracks[0], 0, 'in', -60, frames);
  assert.deepEqual(spans(r.lane), [[90, 250], [250, 350]]);
  assert.equal(r.lane[0].segs[0].in, 40);
});

test('left handle against a neighbour: right edge stays put on screen', () => {
  const { p } = packed(); // A|B|C, trim B's head
  const base = p.tracks[0];
  base[1].segs[0].in = 50; base[1].segs[0].out = 150; // B shows source 50..150, still 100 long
  let r = trimFrom(base, 1, 'in', 30, frames); // shrink
  assert.deepEqual(spans(r.lane), [[0, 100], [100, 170], [170, 270]]);
  assert.equal(r.viewShift, -30);
  assert.equal(r.lane[1].segs[0].out, 150, 'out point never changes');
  r = trimFrom(base, 1, 'in', -20, frames); // grow against A
  assert.deepEqual(spans(r.lane), [[0, 100], [100, 220], [220, 320]]);
  assert.equal(r.viewShift, 20);
  r = trimFrom(base, 1, 'in', -500, frames);
  assert.equal(r.limit, 'start');
  assert.equal(r.lane[1].segs[0].in, 0);
});

test('left handle grows through a gap, then pushes', () => {
  const p = createProject();
  const A = makeClip('a', 100); appendClip(p, A, 0);
  const B = makeClip('b', 300); B.segs[0].in = 100; B.segs[0].out = 200; B.at = 120; p.tracks[0].push(B);
  const r = trimFrom(p.tracks[0], 1, 'in', -50, frames);
  assert.deepEqual(spans(r.lane), [[0, 100], [100, 250]]);
  assert.equal(r.viewShift, 30);
});

test('merge of a clean split restores one piece of footage', () => {
  const { p, B } = packed();
  const right = cut(p, B.id, 140);
  const m = mergeClips(p, B.id, right.id);
  assert.deepEqual(m.segs, [{ src: 'b', in: 0, out: 100 }]);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 200], [200, 300]]);
});

test('merge of unrelated pills keeps both pieces in order', () => {
  const { p, A, C } = packed();
  const m = mergeClips(p, C.id, A.id); // C first, then A
  assert.deepEqual(m.segs.map((s) => s.src), ['c', 'a']);
  assert.equal(clipLen(m), 200);
  assert.deepEqual(spans(p.tracks[0]), [[0, 200], [200, 300]]);
  const hit = locate(m, 150);
  assert.equal(hit.seg.src, 'a');
  assert.equal(hit.srcFrame, 50);
  const piece = cut(p, m.id, 100);
  assert.deepEqual(piece.segs.map((s) => s.src), ['a']);
});

test('flatten lists source intervals per track', () => {
  const { p, A, C } = packed();
  mergeClips(p, A.id, C.id);
  const f = flatten(p);
  assert.deepEqual(f[0].map((s) => [s.at, s.len, s.src, s.in]), [[0, 100, 'a', 0], [100, 100, 'c', 0], [200, 100, 'b', 0]]);
});

test('sanitize drops unknown sources and repairs overlaps', () => {
  const raw = { ratio: '16:9', selected: 'x', tracks: [[
    { id: 'x', at: 0, segs: [{ src: 'a', in: 0, out: 100 }] },
    { id: 'y', at: 50, segs: [{ src: 'b', in: 0, out: 9999 }] },
    { id: 'z', at: 10, segs: [{ src: 'gone', in: 0, out: 10 }] },
  ]] };
  const p = sanitize(raw, frames);
  assert.equal(p.ratio, '16:9');
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 400]]);
  assert.equal(p.tracks.length, 3);
  assert.equal(p.selected, 'x');
  assert.ok(findClip(p, 'y'));
});

test('snap frames include every edge and zero', () => {
  const { p, B } = packed();
  assert.deepEqual(snapFrames(p, B.id), [0, 100, 200, 300]);
});

test('placing a long pill into a short gap pushes what follows', () => {
  const p = createProject();
  const A = makeClip('a', 100); appendClip(p, A, 0);
  const B = makeClip('b', 100); B.at = 120; p.tracks[0].push(B);
  const N = makeClip('c', 80);
  placeClip(p, N, 0, 100);
  assert.deepEqual(spans(p.tracks[0]), [[0, 100], [100, 180], [180, 280]]);
});

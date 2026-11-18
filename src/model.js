// Handcut timeline model. Pure data and pure functions: no DOM, no three.js.
// Every length and position is an integer number of frames at FPS.
//
// A clip is a pill on a track: { id, at, muted, segs: [{ src, in, out }] }.
// `segs` is usually one piece of one source; merging pills concatenates
// their pieces, so a merged pill is still one clip that can be cut, trimmed
// and moved like any other.
//
// The rule that makes the timeline feel physical: pills that touch stay
// together. Stretching a pill pushes its neighbours along; shrinking one
// pulls the pills stuck to it; lifting one out closes the hole behind it.

export const FPS = 30;
export const MAX_TRACKS = 3;
export const MIN_LEN = 3;

let seq = 0;
export function newId(prefix = 'c') {
  seq = (seq + 1) % 1e6;
  return prefix + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 46656).toString(36);
}

export const segLen = (s) => s.out - s.in;
export function clipLen(c) {
  let n = 0;
  for (const s of c.segs) n += s.out - s.in;
  return n;
}
export const clipEnd = (c) => c.at + clipLen(c);
export const cloneClip = (c) => ({
  id: c.id,
  at: c.at,
  muted: !!c.muted,
  segs: c.segs.map((s) => ({ src: s.src, in: s.in, out: s.out })),
});
export const cloneTracks = (tracks) => tracks.map((t) => t.map(cloneClip));

export function createProject() {
  return { tracks: [[], [], []], ratio: '9:16', selected: null };
}

export function makeClip(src, frames, at = 0, from = 0) {
  return { id: newId(), at, muted: false, segs: [{ src, in: from, out: frames }] };
}

export function duration(project) {
  let d = 0;
  for (const t of project.tracks) if (t.length) d = Math.max(d, clipEnd(t[t.length - 1]));
  return d;
}

export function findClip(project, id) {
  if (!id) return null;
  for (let track = 0; track < project.tracks.length; track++) {
    const lane = project.tracks[track];
    for (let index = 0; index < lane.length; index++) {
      if (lane[index].id === id) return { track, index, clip: lane[index], lane };
    }
  }
  return null;
}

export function clipAtFrame(lane, frame) {
  for (const c of lane) {
    if (frame < c.at) return null;
    if (frame < clipEnd(c)) return c;
  }
  return null;
}

/** Which piece of which source is under timeline frame `frame` of this clip. */
export function locate(clip, frame) {
  let off = frame - clip.at;
  if (off < 0) return null;
  let segAt = clip.at;
  for (let index = 0; index < clip.segs.length; index++) {
    const seg = clip.segs[index];
    const n = seg.out - seg.in;
    if (off < n) return { seg, index, srcFrame: seg.in + off, segAt };
    off -= n;
    segAt += n;
  }
  return null;
}

/** Tracks as plain source intervals, the form playback and export consume. */
export function flatten(project) {
  return project.tracks.map((lane) => {
    const out = [];
    for (const c of lane) {
      let at = c.at;
      c.segs.forEach((s, i) => {
        const len = s.out - s.in;
        out.push({ at, len, src: s.src, in: s.in, muted: !!c.muted, clip: c.id, seg: i });
        at += len;
      });
    }
    return out;
  });
}

export function fuseSegs(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.src === s.src && last.out === s.in) last.out = s.out;
    else out.push({ src: s.src, in: s.in, out: s.out });
  }
  return out;
}

/** Slide later pills right until nothing overlaps, starting after index i. */
export function pushRight(lane, i) {
  for (let j = Math.max(1, i + 1); j < lane.length; j++) {
    const min = clipEnd(lane[j - 1]);
    if (lane[j].at >= min) break;
    lane[j].at = min;
  }
}

/** Indices of the pills stuck to the right side of lane[i], in order. */
export function attachedRight(lane, i) {
  const chain = [];
  let end = clipEnd(lane[i]);
  for (let j = i + 1; j < lane.length && lane[j].at === end; j++) {
    chain.push(j);
    end = clipEnd(lane[j]);
  }
  return chain;
}

/** Split a clip at a timeline frame. Returns the new right-hand clip. */
export function cut(project, id, frame) {
  const h = findClip(project, id);
  if (!h) return null;
  const c = h.clip;
  const off = Math.round(frame) - c.at;
  if (off < 1 || off > clipLen(c) - 1) return null;
  const left = [];
  const right = [];
  let acc = 0;
  for (const s of c.segs) {
    const n = s.out - s.in;
    if (acc + n <= off) left.push(s);
    else if (acc >= off) right.push(s);
    else {
      const k = off - acc;
      left.push({ src: s.src, in: s.in, out: s.in + k });
      right.push({ src: s.src, in: s.in + k, out: s.out });
    }
    acc += n;
  }
  c.segs = left;
  const piece = { id: newId(), at: c.at + off, muted: c.muted, segs: right };
  h.lane.splice(h.index + 1, 0, piece);
  return piece;
}

/** Take a pill off its track. The pills stuck to its right close the hole. */
export function liftClip(project, id) {
  const h = findClip(project, id);
  if (!h) return null;
  const len = clipLen(h.clip);
  const chain = attachedRight(h.lane, h.index).map((j) => h.lane[j]);
  h.lane.splice(h.index, 1);
  for (const k of chain) k.at -= len;
  return { clip: h.clip, track: h.track, at: h.clip.at };
}

/**
 * Where a pill of `len` frames lands if dropped at `wantAt` on this lane.
 * Dropping onto another pill inserts before or after it, whichever is nearer.
 */
export function resolvePlacement(lane, len, wantAt) {
  let at = Math.max(0, Math.round(wantAt));
  let index = lane.length;
  for (let i = 0; i < lane.length; i++) {
    const ks = lane[i].at;
    const ke = clipEnd(lane[i]);
    if (at >= ke) continue;
    if (at <= ks) {
      index = i;
      break;
    }
    if (at < (ks + ke) / 2) {
      at = ks;
      index = i;
    } else {
      at = ke;
      index = i + 1;
    }
    break;
  }
  return { at, index };
}

export function placeClip(project, clip, track, wantAt) {
  const lane = project.tracks[track];
  const { at, index } = resolvePlacement(lane, clipLen(clip), wantAt);
  clip.at = at;
  lane.splice(index, 0, clip);
  pushRight(lane, index);
  return at;
}

export function moveClip(project, id, track, wantAt) {
  const lifted = liftClip(project, id);
  if (!lifted) return null;
  return placeClip(project, lifted.clip, track, wantAt);
}

export function appendClip(project, clip, track) {
  const lane = project.tracks[track];
  clip.at = lane.length ? clipEnd(lane[lane.length - 1]) : 0;
  lane.push(clip);
  return clip.at;
}

/**
 * Trim one end of a pill, computed from the lane as it was when the grab
 * began (`baseLane`), so a shaky hand can never accumulate error.
 *
 * `delta` is how far the grabbed end has travelled, in frames (right is +).
 * Returns the new lane, the limit that stopped the end (if any) and
 * `viewShift`: how many frames the view must scroll so the end that is not
 * being held stays exactly where it is in front of the editor.
 *
 *  - Right end: the left end never moves. Growing pushes later pills along;
 *    shrinking pulls the pills stuck to it.
 *  - Left end: the right end never moves on screen. If there is empty track
 *    to the left the pill grows into it; once it meets its neighbour (or the
 *    start of the track) the rest of the track makes room instead.
 */
export function trimFrom(baseLane, index, edge, delta, srcFrames) {
  const lane = baseLane.map(cloneClip);
  const c = lane[index];
  const chain = attachedRight(baseLane, index);
  const single = c.segs.length === 1;
  let limit = '';
  let viewShift = 0;
  if (edge === 'in') {
    const s = c.segs[0];
    const hi = s.out - MIN_LEN;
    let want = s.in + Math.round(delta);
    if (want < 0) {
      want = 0;
      limit = 'start';
    } else if (want > hi) {
      want = hi;
      limit = single ? 'min' : 'piece';
    }
    const d = want - s.in;
    s.in = want;
    const prevEnd = index > 0 ? clipEnd(lane[index - 1]) : 0;
    const gap = c.at - prevEnd;
    if (d >= 0) {
      if (gap === 0) {
        for (const j of chain) lane[j].at -= d;
        viewShift = -d;
      } else c.at += d;
    } else {
      const grow = -d;
      const free = Math.min(grow, gap);
      c.at -= free;
      const rest = grow - free;
      if (rest > 0) {
        pushRight(lane, index);
        viewShift = rest;
      }
    }
  } else {
    const s = c.segs[c.segs.length - 1];
    const lo = s.in + MIN_LEN;
    const hi = Math.max(lo, srcFrames(s.src));
    let want = s.out + Math.round(delta);
    if (want > hi) {
      want = hi;
      limit = 'end';
    } else if (want < lo) {
      want = lo;
      limit = single ? 'min' : 'piece';
    }
    const d = want - s.out;
    s.out = want;
    if (d > 0) pushRight(lane, index);
    else if (d < 0) for (const j of chain) lane[j].at += d;
  }
  return { lane, clip: c, limit, viewShift };
}

/** Join two pills into one: `firstId`'s footage, then `secondId`'s. */
export function mergeClips(project, firstId, secondId) {
  const a = findClip(project, firstId);
  const b = findClip(project, secondId);
  if (!a || !b || firstId === secondId) return null;
  const early = b.clip.at < a.clip.at ? b : a;
  const track = early.track;
  const at = early.clip.at;
  const merged = {
    id: newId(),
    at,
    muted: a.clip.muted && b.clip.muted,
    segs: fuseSegs([...a.clip.segs, ...b.clip.segs]),
  };
  liftClip(project, firstId);
  liftClip(project, secondId);
  placeClip(project, merged, track, at);
  return merged;
}

/** Frames worth snapping to: every pill edge on every track, and frame 0. */
export function snapFrames(project, excludeId) {
  const set = new Set([0]);
  for (const lane of project.tracks) {
    for (const c of lane) {
      if (c.id === excludeId) continue;
      set.add(c.at);
      set.add(clipEnd(c));
    }
  }
  return [...set].sort((x, y) => x - y);
}

/** Rebuild a saved project, dropping anything that no longer makes sense. */
export function sanitize(raw, srcFrames) {
  const project = createProject();
  if (!raw || !Array.isArray(raw.tracks)) return project;
  project.ratio = raw.ratio === '16:9' ? '16:9' : '9:16';
  const seen = new Set();
  raw.tracks.slice(0, MAX_TRACKS).forEach((lane, t) => {
    if (!Array.isArray(lane)) return;
    const clips = [];
    for (const c of lane) {
      if (!c || !Array.isArray(c.segs)) continue;
      const segs = [];
      for (const s of c.segs) {
        const frames = s && srcFrames(s.src);
        if (!frames) continue;
        const a = Math.max(0, Math.min(frames - 1, Math.round(s.in) || 0));
        const b = Math.max(a + 1, Math.min(frames, Math.round(s.out) || 0));
        segs.push({ src: s.src, in: a, out: b });
      }
      if (!segs.length) continue;
      let id = typeof c.id === 'string' && !seen.has(c.id) ? c.id : newId();
      seen.add(id);
      clips.push({ id, at: Math.max(0, Math.round(c.at) || 0), muted: !!c.muted, segs });
    }
    clips.sort((x, y) => x.at - y.at);
    for (let i = 1; i < clips.length; i++) {
      const min = clipEnd(clips[i - 1]);
      if (clips[i].at < min) clips[i].at = min;
    }
    project.tracks[t] = clips;
  });
  project.selected = findClip(project, raw.selected) ? raw.selected : null;
  return project;
}

export function timecode(frame) {
  const f = Math.max(0, Math.round(frame));
  const s = Math.floor(f / FPS);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + ':' + String(f % FPS).padStart(2, '0');
}

export function seconds(frames) {
  const s = frames / FPS;
  return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60).toFixed(0).padStart(2, '0') + 's' : s.toFixed(1) + 's';
}

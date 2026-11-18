// Editor state: the project, the playhead, undo history and every command
// the hands can perform. Rendering and input never change the project
// directly; they call these commands, which keep undo, autosave and the
// "what just happened" events in one place.

import {
  FPS, cloneClip, clipLen, clipEnd, createProject, makeClip, duration, findClip, clipAtFrame,
  cut, liftClip, placeClip, appendClip, resolvePlacement, trimFrom, fuseSegs, sanitize, newId, pushRight,
} from './model.js';

const STORE_KEY = 'handcut-project-v1';
const ZOOMS = [0.014, 0.022, 0.032, 0.045, 0.065, 0.095, 0.14];

export class Editor {
  constructor(library) {
    this.library = library;
    this.project = createProject();
    this.time = 0; // playhead, in frames (fractional while playing or coasting)
    this.playing = false;
    this.revision = 0;
    this.zoomIndex = 3;
    this.undoStack = [];
    this.redoStack = [];
    this.held = new Map(); // clips lifted off the timeline by a hand
    this.trim = null; // live trim: { id, edge, limit, edgeFrame, len, baseLen }
    this.drop = null; // live drop preview: { track, at, len, lane }
    this.handlers = new Map();
    this.selectedAt = 0;
  }

  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(fn);
  }
  emit(name, data) {
    for (const fn of this.handlers.get(name) || []) fn(data || {});
  }

  get scale() {
    return ZOOMS[this.zoomIndex]; // metres of track per second
  }
  zoom(dir) {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + dir));
    if (next === this.zoomIndex) return false;
    this.zoomIndex = next;
    this.persist();
    return true;
  }

  duration() {
    return duration(this.project);
  }
  selection() {
    return findClip(this.project, this.project.selected)?.clip || null;
  }
  srcFrames = (id) => this.library.frames(id);

  /** The frame shown on the big screen: the trimmed edge while trimming. */
  viewFrame() {
    if (this.trim) return this.trim.edgeFrame;
    return this.time;
  }

  // ---- persistence -------------------------------------------------------

  load() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(STORE_KEY));
    } catch {}
    if (raw && Array.isArray(raw.tracks)) {
      this.project = sanitize(raw, this.srcFrames);
      this.zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, Number.isInteger(raw.zoom) ? raw.zoom : 3));
      this.time = Math.max(0, Math.min(this.duration(), Math.round(raw.time) || 0));
      return true;
    }
    this.starter();
    return false;
  }

  starter() {
    const p = createProject();
    const a = this.library.get('s-aurora');
    const b = this.library.get('s-fractal');
    if (a) {
      const c = makeClip(a.id, 180, 0, 30);
      appendClip(p, c, 0);
    }
    if (b) {
      const c = makeClip(b.id, 210, 0, 60);
      appendClip(p, c, 0);
    }
    this.project = p;
    this.time = 60;
  }

  snapshot() {
    // Clips in a hand still belong to the project: record them where they came from.
    const tracks = this.project.tracks.map((t) => t.map(cloneClip));
    const temp = { tracks };
    for (const h of this.held.values()) if (!h.isNew) placeClip(temp, cloneClip(h.clip), h.fromTrack, h.fromAt);
    return JSON.stringify({ tracks, ratio: this.project.ratio, selected: this.project.selected });
  }

  persist() {
    try {
      const data = JSON.parse(this.snapshot());
      data.time = Math.round(this.time);
      data.zoom = this.zoomIndex;
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {}
  }

  restore(json) {
    const data = JSON.parse(json);
    this.project = sanitize(data, this.srcFrames);
    this.held.clear();
    this.trim = null;
    this.drop = null;
    this.time = Math.max(0, Math.min(this.duration(), this.time));
    this.revision++;
  }

  commit(before) {
    if (before === this.snapshot()) return false;
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this.revision++;
    this.time = Math.max(0, Math.min(this.duration(), this.time));
    this.persist();
    return true;
  }

  edit(fn) {
    const before = this.snapshot();
    const out = fn();
    this.commit(before);
    return out;
  }

  undo() {
    if (!this.undoStack.length || this.held.size || this.trim) return false;
    this.stop();
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    this.persist();
    this.emit('undo');
    return true;
  }
  redo() {
    if (!this.redoStack.length || this.held.size || this.trim) return false;
    this.stop();
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    this.persist();
    this.emit('redo');
    return true;
  }

  // ---- transport ---------------------------------------------------------

  seek(frame, { fine = false } = {}) {
    const d = this.duration();
    const f = Math.max(0, Math.min(d, frame));
    this.time = fine ? f : Math.round(f);
  }
  play() {
    if (this.playing || !this.duration()) return;
    if (this.time >= this.duration() - 1) this.time = 0;
    this.playing = true;
    this.emit('play');
  }
  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.time = Math.round(this.time);
    this.persist();
    this.emit('pause');
  }
  togglePlay() {
    if (this.playing) this.stop();
    else this.play();
  }

  // ---- selection and simple edits ---------------------------------------

  select(id, { quiet = false } = {}) {
    if (this.project.selected === id) return;
    this.project.selected = id || null;
    this.selectedAt = performance.now();
    this.revision++;
    if (id && !quiet) this.emit('select', { id });
  }

  /** Can the selected pill be cut at the playhead? Returns '' or the reason it cannot. */
  cutBlocker() {
    const h = findClip(this.project, this.project.selected);
    if (!h) return 'select';
    const f = Math.round(this.time);
    if (f <= h.clip.at || f >= clipEnd(h.clip)) return 'outside';
    return '';
  }

  cutSelected() {
    const why = this.cutBlocker();
    if (why) {
      this.emit('denied', { reason: why, id: this.project.selected });
      return null;
    }
    this.stop();
    const id = this.project.selected;
    const frame = Math.round(this.time);
    const piece = this.edit(() => {
      const right = cut(this.project, id, frame);
      if (right) this.project.selected = right.id;
      return right;
    });
    if (piece) {
      this.selectedAt = performance.now();
      this.emit('cut', { left: id, right: piece.id, frame, track: findClip(this.project, piece.id).track });
    }
    return piece;
  }

  /** The Split key: cut the selected pill, or whatever pill is under the line. */
  splitAtPlayhead() {
    if (this.cutBlocker()) {
      const f = Math.round(this.time);
      for (const lane of this.project.tracks) {
        const c = clipAtFrame(lane, f);
        if (c && f > c.at) {
          this.select(c.id, { quiet: true });
          break;
        }
      }
    }
    return this.cutSelected();
  }

  deleteSelected() {
    const h = findClip(this.project, this.project.selected);
    if (!h) {
      this.emit('denied', { reason: 'select' });
      return false;
    }
    this.stop();
    const info = { id: h.clip.id, track: h.track, at: h.clip.at, len: clipLen(h.clip) };
    this.edit(() => {
      liftClip(this.project, info.id);
      this.project.selected = null;
    });
    this.emit('delete', info);
    return true;
  }

  toggleMute() {
    const c = this.selection();
    if (!c) {
      this.emit('denied', { reason: 'select' });
      return;
    }
    this.edit(() => {
      c.muted = !c.muted;
    });
    this.emit('mute', { id: c.id, muted: c.muted });
  }

  toggleRatio() {
    this.edit(() => {
      this.project.ratio = this.project.ratio === '9:16' ? '16:9' : '9:16';
    });
    this.emit('ratio', { ratio: this.project.ratio });
  }

  /** Tap in the library: the recording lands at the end of the working track. */
  appendSource(srcId) {
    const src = this.library.get(srcId);
    if (!src) return null;
    this.stop();
    const sel = findClip(this.project, this.project.selected);
    const track = sel ? sel.track : 0;
    const clip = makeClip(src.id, src.frames);
    this.edit(() => {
      appendClip(this.project, clip, track);
      this.project.selected = clip.id;
    });
    this.selectedAt = performance.now();
    this.time = clip.at;
    this.emit('add', { id: clip.id });
    return clip;
  }

  // ---- live gestures -----------------------------------------------------

  /** Lift a pill into a hand. */
  beginMove(id) {
    const h = findClip(this.project, id);
    if (!h || this.trim) return null;
    this.stop();
    if (this.project.selected !== id) this.selectedAt = performance.now();
    this.project.selected = id;
    const before = this.snapshot();
    const lifted = liftClip(this.project, id);
    const entry = { clip: lifted.clip, fromTrack: lifted.track, fromAt: lifted.at, before, isNew: false };
    this.held.set(id, entry);
    this.revision++;
    return this.moveHandle(entry);
  }

  /** Carry a fresh recording out of the library. */
  beginAdd(srcId) {
    const src = this.library.get(srcId);
    if (!src || this.trim) return null;
    this.stop();
    const before = this.snapshot();
    const clip = makeClip(src.id, src.frames);
    const entry = { clip, fromTrack: 0, fromAt: 0, before, isNew: true };
    // A new clip is in the hand, but not part of the saved project until it is dropped.
    this.held.set(clip.id, entry);
    this.revision++;
    return this.moveHandle(entry);
  }

  moveHandle(entry) {
    const ed = this;
    const id = entry.clip.id;
    return {
      clip: entry.clip,
      entry,
      /** Where it would land, plus the lane as it would look. */
      preview(track, wantAt) {
        const lane = ed.project.tracks[track].map(cloneClip);
        const len = clipLen(entry.clip);
        const spot = resolvePlacement(lane, len, wantAt);
        const ghost = { ...cloneClip(entry.clip), at: spot.at };
        lane.splice(spot.index, 0, ghost);
        pushRight(lane, spot.index);
        ed.drop = { track, at: spot.at, len, lane, id };
        return spot;
      },
      clearPreview() {
        if (ed.drop?.id === id) ed.drop = null;
      },
      commit(track, wantAt) {
        ed.held.delete(id);
        if (ed.drop?.id === id) ed.drop = null;
        placeClip(ed.project, entry.clip, track, wantAt);
        ed.project.selected = id;
        ed.selectedAt = performance.now();
        const changed = ed.commit(entry.before);
        if (!changed) ed.revision++;
        ed.emit(entry.isNew ? 'add' : 'drop', { id, changed });
      },
      cancel() {
        ed.held.delete(id);
        if (ed.drop?.id === id) ed.drop = null;
        if (!entry.isNew) placeClip(ed.project, entry.clip, entry.fromTrack, entry.fromAt);
        ed.revision++;
        ed.emit('return', { id });
      },
    };
  }

  /** Two held pills, pressed together long enough: one pill, left one first. */
  mergeHeld(firstHandle, secondHandle) {
    const a = firstHandle.entry;
    const b = secondHandle.entry;
    // Snapshots record held pills where they came from, so either one is the state before both grabs.
    const before = a.isNew ? b.before : a.before;
    const earliest = [a, b].filter((e) => !e.isNew).sort((x, y) => x.fromAt - y.fromAt)[0] || a;
    this.held.delete(a.clip.id);
    this.held.delete(b.clip.id);
    this.drop = null;
    const merged = {
      id: newId(),
      at: earliest.fromAt,
      muted: a.clip.muted && b.clip.muted,
      segs: fuseSegs([...a.clip.segs, ...b.clip.segs]),
    };
    placeClip(this.project, merged, earliest.fromTrack, earliest.fromAt);
    this.project.selected = merged.id;
    this.selectedAt = performance.now();
    this.commit(before);
    this.emit('merge', { id: merged.id });
    return merged;
  }

  /** Grab one end of a pill. */
  beginTrim(id, edge) {
    const h = findClip(this.project, id);
    if (!h || this.held.size) return null;
    this.stop();
    const ed = this;
    if (this.project.selected !== id) this.selectedAt = performance.now();
    this.project.selected = id;
    const before = this.snapshot();
    const baseLane = h.lane.map(cloneClip);
    const baseTime = this.time;
    const baseLen = clipLen(h.clip);
    const track = h.track;
    const index = h.index;
    const apply = (delta) => {
      const r = trimFrom(baseLane, index, edge, delta, ed.srcFrames);
      ed.project.tracks[track] = r.lane;
      ed.time = Math.max(0, baseTime + r.viewShift);
      const len = clipLen(r.clip);
      ed.trim = { id, edge, limit: r.limit, len, baseLen, edgeFrame: edge === 'in' ? r.clip.at : clipEnd(r.clip) - 1 };
      ed.revision++;
      return ed.trim;
    };
    apply(0);
    return {
      update: apply,
      commit() {
        ed.trim = null;
        const changed = ed.commit(before);
        if (!changed) ed.revision++;
        ed.time = Math.round(Math.max(0, Math.min(ed.duration(), ed.time)));
        ed.emit('trimmed', { id, changed });
      },
      cancel() {
        ed.trim = null;
        ed.project.tracks[track] = baseLane;
        ed.time = baseTime;
        ed.revision++;
      },
    };
  }

  /** One-line description of the project for the status readout. */
  summary() {
    let n = 0;
    for (const t of this.project.tracks) n += t.length;
    return n + (n === 1 ? ' clip' : ' clips') + ' · ' + (this.duration() / FPS).toFixed(1) + 's';
  }
}

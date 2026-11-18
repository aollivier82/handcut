// Preview playback. Each track owns two <video> elements: one showing the
// piece under the playhead and one standing by, already parked on the first
// frame of the next piece, so a cut plays through without a hitch.
//
// The playhead is the clock. While playing it follows the lowest track's
// video so sound and picture stay together; it waits (briefly) for a video
// that is still seeking rather than running ahead of it.

import * as THREE from 'three';
import { FPS, clipAtFrame, locate, duration } from './model.js';

class Slot {
  constructor() {
    const el = document.createElement('video');
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.muted = true;
    el.disableRemotePlayback = true;
    this.el = el;
    this.srcId = null;
    this.key = null;
    this.target = null;
    this.dirty = 0;
    this.failed = false;
    this.lastUpload = 0;
    this.tex = new THREE.VideoTexture(el);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    const settle = () => {
      this.dirty = 4;
      if (this.target != null && Math.abs(el.currentTime - this.target) > 0.02 && !el.seeking) el.currentTime = this.target;
    };
    el.addEventListener('seeked', settle);
    el.addEventListener('loadeddata', settle);
    el.addEventListener('loadedmetadata', settle);
    el.addEventListener('error', () => {
      if (this.srcId) this.failed = true;
    });
  }
  load(source) {
    if (this.srcId === source.id) return;
    this.srcId = source.id;
    this.failed = false;
    this.target = null;
    this.el.src = source.url;
    this.el.load();
  }
  /** Ask for a time; requests made while a seek is in flight collapse into the latest one. */
  seek(t) {
    this.target = t;
    const el = this.el;
    if (el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - t) > 0.012) el.currentTime = t;
  }
  ready() {
    return this.el.readyState >= 2 && !this.el.seeking;
  }
  park() {
    if (!this.el.paused) this.el.pause();
    this.key = null;
  }
}

export class Player {
  constructor(editor, library) {
    this.editor = editor;
    this.library = library;
    this.tracks = [0, 1, 2].map(() => ({ cur: new Slot(), next: new Slot(), key: null }));
    this.bands = [];
    this.stall = 0;
    this.warned = new Set();
    this.blocked = false;
  }

  /** Call from a tap or click so later play() calls are allowed to make sound. */
  prime() {
    for (const t of this.tracks) {
      for (const s of [t.cur, t.next]) {
        if (!s.srcId) continue;
        const p = s.el.play();
        if (p) p.then(() => !this.editor.playing && s.el.pause()).catch(() => {});
      }
    }
  }

  nextPiece(lane, clip, hit) {
    if (hit.index + 1 < clip.segs.length) {
      const seg = clip.segs[hit.index + 1];
      return { seg, key: clip.id + ':' + (hit.index + 1), gap: 0 };
    }
    const i = lane.indexOf(clip);
    const n = lane[i + 1];
    if (!n) return null;
    const end = hit.segAt + (hit.seg.out - hit.seg.in);
    return { seg: n.segs[0], key: n.id + ':0', gap: n.at - end };
  }

  update(dtMs, now) {
    const ed = this.editor;
    const playing = ed.playing;
    const frame = playing ? ed.time : ed.viewFrame();
    const f = Math.floor(frame + 1e-4);
    const bands = [];
    let waiting = false;
    let lead = null;

    for (let t = 0; t < 3; t++) {
      const st = this.tracks[t];
      const lane = ed.project.tracks[t];
      const clip = clipAtFrame(lane, f);
      const hit = clip && locate(clip, f);
      const source = hit && this.library.get(hit.seg.src);
      if (!hit || !source) {
        if (st.key) {
          st.cur.park();
          st.key = null;
        }
        if (!playing) st.next.park();
        continue;
      }
      const key = clip.id + ':' + hit.index;
      const expected = (hit.srcFrame + (playing ? frame - f : 0.5)) / FPS;

      if (st.key !== key) {
        const rolling = playing && st.cur.srcId === source.id && !st.cur.el.paused && Math.abs(st.cur.el.currentTime - expected) < 0.14;
        if (!rolling) {
          let parked = false;
          if (st.next.key === key && st.next.srcId === source.id) {
            const old = st.cur;
            st.cur = st.next;
            st.next = old;
            old.park();
            // Already sitting on the first frame: start it, do not seek again.
            parked = Math.abs(st.cur.el.currentTime - expected) < 0.12;
            if (parked) st.cur.target = null;
          }
          if (!parked) {
            st.cur.load(source);
            st.cur.seek(expected);
          }
        }
        st.key = key;
        st.cur.key = key;
      }

      const slot = st.cur;
      const el = slot.el;
      slot.load(source);
      if (slot.failed) {
        if (!this.warned.has(source.id)) {
          this.warned.add(source.id);
          ed.emit('notice', { text: 'This headset cannot play "' + source.name + '"', long: true });
        }
      } else if (playing) {
        el.muted = !!clip.muted || this.blocked;
        if (slot.ready()) {
          const drift = el.currentTime - expected;
          const atEnd = el.ended || (el.duration > 0 && el.currentTime > el.duration - 0.06);
          if (atEnd) {
            // the recording has run out a hair before the pill does: let the clock finish the pill
          } else if (el.paused) {
            if (Math.abs(drift) > 0.07) slot.seek(expected);
            else {
              slot.target = null;
              const p = el.play();
              if (p) {
                p.catch((e) => {
                  if (e && e.name === 'NotAllowedError' && !this.blocked) {
                    this.blocked = true; // sound needs a tap first: keep the picture moving
                    el.muted = true;
                    el.play().catch(() => {});
                    ed.emit('notice', { text: 'Pinch once to turn the sound on' });
                  }
                });
              }
            }
            waiting = true;
          } else if (lead == null) {
            // The lowest track's video is the clock. It is only pulled back into
            // place if it is badly off, because a seek costs far more than a late frame.
            if (Math.abs(drift) > 1.2) {
              slot.seek(expected);
              waiting = true;
            } else lead = hit.segAt + el.currentTime * FPS - hit.seg.in;
          } else if (Math.abs(drift) > 0.3) {
            slot.seek(expected); // an upper track that has wandered from the clock
          }
        } else waiting = true;

        // Park the standby video on the first frame of whatever comes next.
        const left = hit.segAt + (hit.seg.out - hit.seg.in) - frame;
        if (left < FPS * 1.5) {
          const nx = this.nextPiece(lane, clip, hit);
          const nsrc = nx && this.library.get(nx.seg.src);
          const seamless = nx && nx.gap === 0 && nx.seg.src === hit.seg.src && nx.seg.in === hit.seg.out;
          if (nsrc && !seamless && nx.gap < FPS * 2 && st.next.key !== nx.key) {
            st.next.load(nsrc);
            if (!st.next.el.paused) st.next.el.pause();
            st.next.el.muted = true;
            st.next.seek((nx.seg.in + 0.5) / FPS);
            st.next.key = nx.key;
          }
        }
      } else {
        if (!el.paused) el.pause();
        el.muted = true;
        slot.seek(expected);
      }

      // Hand the picture to the screen. Uploading a frame costs GPU time, so
      // do it when the picture actually changes.
      const has = el.readyState >= 2 && !slot.failed;
      if (has) {
        if (playing && !el.paused) {
          if (now - slot.lastUpload > 28) {
            slot.tex.needsUpdate = true;
            slot.lastUpload = now;
          }
        } else if (slot.dirty > 0) {
          slot.dirty--;
          slot.tex.needsUpdate = true;
        }
      }
      bands.push({ track: t, tex: slot.tex, ready: has, w: el.videoWidth || source.width, h: el.videoHeight || source.height, color: source.color });
    }

    bands.reverse(); // highest track first: it takes the top band
    this.bands = bands;

    if (playing) {
      const d = duration(ed.project);
      if (lead != null) {
        // follow the video: hold if it is behind, jump if the page hitched and it ran on
        if (lead > ed.time) ed.time = lead;
        this.stall = 0;
      } else if (!waiting || this.stall > 1500) {
        ed.time += (dtMs * FPS) / 1000;
        if (!waiting) this.stall = 0;
      } else this.stall += dtMs;
      if (ed.time >= d) {
        ed.time = d;
        ed.stop();
      }
    } else this.stall = 0;
  }

  /** Sound was blocked until a real input event: try again after one. */
  unblock() {
    if (!this.blocked) return;
    this.blocked = false;
  }

  stopAll() {
    for (const t of this.tracks) {
      t.cur.el.pause();
      t.next.el.pause();
    }
  }
}

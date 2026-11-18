// The media library: bundled sample clips plus whatever the editor imports
// from the headset's gallery. Imported recordings are kept in IndexedDB so a
// project survives leaving and re-entering the page.

import { FPS } from './model.js';

const COLORS = ['#ff8a5b', '#5bd6c8', '#b79cff', '#ffd166', '#7fb4ff', '#ff7aa8', '#9be36b', '#f4a261'];
const SAMPLES = [
  { id: 's-aurora', name: 'Aurora', url: './media/aurora.mp4', frames: 300, width: 1280, height: 720 },
  { id: 's-fractal', name: 'Fractal', url: './media/fractal.mp4', frames: 300, width: 1280, height: 720 },
  { id: 's-cells', name: 'Cells', url: './media/cells.mp4', frames: 240, width: 1280, height: 720 },
];
const CELL_W = 96;
const CELL_H = 54;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('handcut', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sources', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('sources', mode);
    const out = fn(t.objectStore('sources'));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = t.onabort = () => reject(t.error || new Error('Storage failed'));
  });
}

function probe(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    const timer = setTimeout(() => finish(new Error('This video took too long to open.')), 20000);
    function finish(err) {
      clearTimeout(timer);
      v.onloadedmetadata = v.onerror = null;
      const info = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      v.removeAttribute('src');
      v.load();
      if (err) reject(err);
      else if (!Number.isFinite(info.duration) || info.duration <= 0 || !info.width) reject(new Error('This file has no playable video.'));
      else resolve(info);
    }
    v.onloadedmetadata = () => finish();
    v.onerror = () => finish(new Error('This browser cannot play that video format.'));
    v.src = url;
  });
}

export class Library {
  constructor() {
    this.sources = new Map();
    this.order = [];
    this.version = 0;
    this.db = null;
    this.queue = [];
    this.working = false;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }
  changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
  get(id) {
    return this.sources.get(id);
  }
  frames(id) {
    return this.sources.get(id)?.frames || 0;
  }
  list() {
    return this.order.map((id) => this.sources.get(id));
  }

  register(src) {
    src.color = src.color || COLORS[this.order.length % COLORS.length];
    src.cells = Math.max(4, Math.min(24, Math.ceil(src.frames / FPS / 1.5)));
    const canvas = document.createElement('canvas');
    canvas.width = src.cells * CELL_W;
    canvas.height = CELL_H;
    const g = canvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, canvas.width, 0);
    grad.addColorStop(0, src.color);
    grad.addColorStop(1, '#1b2030');
    g.fillStyle = grad;
    g.fillRect(0, 0, canvas.width, canvas.height);
    src.strip = { canvas, version: 0, done: false };
    this.sources.set(src.id, src);
    if (!this.order.includes(src.id)) this.order.push(src.id);
    this.queue.push(src);
    this.pump();
    return src;
  }

  async init() {
    for (const s of SAMPLES) this.register({ ...s, sample: true });
    try {
      this.db = await openDb();
      const rows = await tx(this.db, 'readonly', (store) => store.getAll());
      rows.sort((a, b) => (a.added || 0) - (b.added || 0));
      for (const r of rows) {
        if (!r.blob) continue;
        this.register({ id: r.id, name: r.name, frames: r.frames, width: r.width, height: r.height, color: r.color, blob: r.blob, url: URL.createObjectURL(r.blob) });
      }
    } catch {
      this.db = null;
    }
    this.changed();
  }

  /** Add recordings picked from the gallery. Returns { added, failed, sessionOnly }. */
  async importFiles(files) {
    const result = { added: [], failed: [], sessionOnly: 0 };
    for (const file of files) {
      const url = URL.createObjectURL(file);
      try {
        const info = await probe(url);
        const id = 'm' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
        const name = (file.name || 'Recording').replace(/\.[a-z0-9]+$/i, '').slice(0, 40);
        const src = this.register({ id, name, frames: Math.max(1, Math.floor(info.duration * FPS)), width: info.width, height: info.height, blob: file, url });
        result.added.push(src);
        try {
          if (!this.db) throw new Error('no storage');
          await tx(this.db, 'readwrite', (store) => store.put({ id, name, frames: src.frames, width: src.width, height: src.height, color: src.color, blob: file, added: Date.now() }));
        } catch {
          result.sessionOnly++;
        }
      } catch (e) {
        URL.revokeObjectURL(url);
        result.failed.push((file.name || 'File') + ': ' + e.message);
      }
    }
    this.changed();
    return result;
  }

  async blobFor(id) {
    const s = this.sources.get(id);
    if (!s) throw new Error('A recording used in this edit is missing.');
    if (s.blob) return s.blob;
    const res = await fetch(s.url);
    if (!res.ok) throw new Error('Could not read "' + s.name + '".');
    s.blob = await res.blob();
    return s.blob;
  }

  // Film strips: one small frame every second or two, drawn in the
  // background so pills show what is inside them.
  async pump() {
    if (this.working) return;
    this.working = true;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    while (this.queue.length) {
      const src = this.queue.shift();
      try {
        await new Promise((resolve, reject) => {
          v.onloadeddata = resolve;
          v.onerror = () => reject(new Error('strip'));
          v.src = src.url;
        });
        const g = src.strip.canvas.getContext('2d');
        const dur = src.frames / FPS;
        for (let i = 0; i < src.cells; i++) {
          const t = Math.min(dur - 0.05, ((i + 0.5) / src.cells) * dur);
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2500);
            v.onseeked = () => {
              clearTimeout(timer);
              resolve();
            };
            v.currentTime = Math.max(0, t);
          });
          const vw = v.videoWidth || 16;
          const vh = v.videoHeight || 9;
          const scale = Math.max(CELL_W / vw, CELL_H / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          g.save();
          g.beginPath();
          g.rect(i * CELL_W, 0, CELL_W, CELL_H);
          g.clip();
          g.drawImage(v, i * CELL_W + (CELL_W - dw) / 2, (CELL_H - dh) / 2, dw, dh);
          g.restore();
          src.strip.version++;
        }
        src.strip.done = true;
      } catch {
        src.strip.done = true;
      }
      v.onloadeddata = v.onerror = v.onseeked = null;
    }
    v.removeAttribute('src');
    v.load();
    this.working = false;
  }
}

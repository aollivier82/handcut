// Procedural interface sounds. No samples: every sound is a few oscillators
// and a noise burst, so the whole kit costs nothing to download.

let ctx = null;
let master = null;
let noiseBuffer = null;
let enabled = true;
let charge = null;
const last = new Map();

export function primeAudio() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.55;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 6;
      master.connect(limiter).connect(ctx.destination);
      const n = Math.floor(ctx.sampleRate * 0.5);
      noiseBuffer = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuffer.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch {
    ctx = null;
  }
}

export function setSoundEnabled(on) {
  enabled = on;
}

function tone(f0, f1, at, dur, gain, type = 'sine') {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(at, dur, gain, freq, q = 1, type = 'bandpass') {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.2);
  src.stop(t + dur + 0.02);
}

const KIT = {
  tick: () => tone(1250, 900, 0, 0.022, 0.05, 'triangle'),
  ratchet: () => tone(620, 520, 0, 0.018, 0.045, 'square'),
  press: () => {
    tone(420, 250, 0, 0.07, 0.16, 'triangle');
    noise(0, 0.03, 0.08, 2600, 0.8);
  },
  release: () => tone(300, 460, 0, 0.05, 0.05, 'triangle'),
  select: () => {
    tone(660, 990, 0, 0.07, 0.09);
    tone(1320, 1320, 0.03, 0.06, 0.035);
  },
  grab: () => {
    tone(240, 330, 0, 0.07, 0.1);
    noise(0, 0.04, 0.05, 900, 1.2);
  },
  drop: () => {
    tone(330, 170, 0, 0.11, 0.15, 'triangle');
    noise(0, 0.05, 0.07, 500, 0.9);
  },
  snap: () => {
    tone(1500, 1100, 0, 0.03, 0.08, 'square');
    tone(520, 380, 0.005, 0.05, 0.08, 'triangle');
  },
  // The cut: a bright blade, a low thump, and two halves ringing apart.
  cut: () => {
    noise(0, 0.09, 0.42, 5200, 0.7, 'highpass');
    tone(2400, 520, 0, 0.07, 0.2, 'sawtooth');
    tone(170, 58, 0.012, 0.2, 0.42);
    tone(880, 1320, 0.07, 0.12, 0.07);
    tone(1320, 1760, 0.11, 0.14, 0.05);
  },
  denied: () => {
    tone(190, 140, 0, 0.09, 0.14, 'square');
    tone(150, 110, 0.07, 0.11, 0.12, 'square');
  },
  limit: () => {
    tone(140, 90, 0, 0.09, 0.2, 'triangle');
    noise(0, 0.03, 0.06, 300, 1);
  },
  bing: () => {
    tone(1046, 1046, 0, 0.5, 0.16);
    tone(1568, 1568, 0.07, 0.6, 0.13);
    tone(2093, 2093, 0.14, 0.7, 0.07);
  },
  pop: () => {
    tone(280, 900, 0, 0.06, 0.26);
    noise(0, 0.05, 0.16, 1800, 0.6);
  },
  poof: () => {
    noise(0, 0.22, 0.2, 700, 0.5, 'lowpass');
    tone(360, 110, 0, 0.16, 0.12);
  },
  undo: () => tone(520, 260, 0, 0.13, 0.11, 'triangle'),
  redo: () => tone(260, 520, 0, 0.13, 0.11, 'triangle'),
  play: () => {
    tone(392, 392, 0, 0.08, 0.1);
    tone(587, 587, 0.06, 0.12, 0.1);
  },
  pause: () => {
    tone(587, 587, 0, 0.08, 0.09);
    tone(392, 392, 0.06, 0.12, 0.09);
  },
  done: () => {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, f, i * 0.09, 0.35, 0.12));
  },
  whoosh: () => noise(0, 0.25, 0.1, 1200, 0.4),
};

export function sfx(name, { rate = 0, pitch = 1 } = {}) {
  if (!enabled || !ctx || ctx.state !== 'running') return;
  const now = performance.now();
  if (rate && now - (last.get(name) || 0) < rate) return;
  last.set(name, now);
  if (name === 'spawn') {
    tone(300 * pitch, 720 * pitch, 0, 0.07, 0.14);
    noise(0, 0.04, 0.05, 2200 * pitch, 0.8);
    return;
  }
  KIT[name]?.();
}

/** Rising hum while two pills are held together. progress 0..1, or null to stop. */
export function chargeTone(progress) {
  if (!ctx || ctx.state !== 'running' || !enabled) return;
  if (progress == null || progress <= 0) {
    if (charge) {
      const { o, g } = charge;
      g.gain.cancelScheduledValues(ctx.currentTime);
      g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03);
      o.stop(ctx.currentTime + 0.15);
      charge = null;
    }
    return;
  }
  if (!charge) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    g.gain.value = 0.0001;
    o.connect(g).connect(master);
    o.start();
    charge = { o, g };
  }
  charge.o.frequency.setTargetAtTime(220 + 440 * progress * progress, ctx.currentTime, 0.03);
  charge.g.gain.setTargetAtTime(0.05 + 0.08 * progress, ctx.currentTime, 0.03);
}

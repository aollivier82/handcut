// End-to-end check of src/export.js: `node tools/export-check.mjs` from the project root.
//
// Starts a Vite dev server for this project and a headless Microsoft Edge, runs the export cases in
// tools/export-check.html over the Chrome DevTools Protocol, writes each exported file to work/export-check/ and
// checks it with ffprobe and ffmpeg. Exits non-zero when any check fails. Only the two processes started here are
// stopped at the end.
//
// Environment: EDGE_PATH (browser executable), EDGE_FLAGS (extra browser flags, space separated),
// ONLY (comma separated case names), VERBOSE=1 (print the page's console),
// MODULE (another copy of the exporter to load instead of src/export.js, as a path from the project root).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'work', 'export-check');
const edgePath = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const reservedPorts = new Set([47839, 47841, 8140, 8790, 8793]);
const SIZES = { '9:16': [720, 1280], '16:9': [1280, 720] };
const FPS = 30;
const SOURCE_FPS = 30;
const rateOf = (spec) => spec.fps ?? FPS;
const PCM_RATE = 8000;

const failures = [];
const notes = [];
const pageLog = [];
const check = (name, ok, detail = '') => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
	if (!ok) {
		failures.push(`${name}${detail ? ` (${detail})` : ''}`);
	}
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const withTimeout = (promise, ms, what) => Promise.race([
	promise,
	new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${what}`)), ms)),
]);

// ---------------------------------------------------------------------------------------------------------------
// Sources and cases

/** Source id -> file on disk, URL in the page, and what ffmpeg sees after rotation. */
const sources = {
	aurora: { file: join(root, 'public/media/aurora.mp4'), width: 1280, height: 720, frames: 300 },
	fractal: { file: join(root, 'public/media/fractal.mp4'), width: 1280, height: 720, frames: 300 },
	cells: { file: join(root, 'public/media/cells.mp4'), width: 1280, height: 720, frames: 240 },
	// Made below: a large frame with 44.1 kHz mono sound, and a clip carrying a 90 degree rotation
	big: { file: join(outDir, 'src/big.mp4'), url: '/work/export-check/src/big.mp4', width: 2560, height: 1440, frames: 90 },
	turned: { file: join(outDir, 'src/turned.mp4'), url: '/work/export-check/src/turned.mp4', width: 720, height: 1280, frames: 90 },
};

const stacked = [
	[{ at: 0, len: 150, src: 'aurora', in: 0, muted: false }],
	[{ at: 30, len: 90, src: 'fractal', in: 60, muted: false }],
	[],
];

const cases = [
	{
		name: 'case1-single',
		ratio: '9:16',
		totalFrames: 150,
		tracks: [[
			{ at: 0, len: 90, src: 'aurora', in: 30, muted: false },
			{ at: 90, len: 60, src: 'cells', in: 0, muted: false },
		]],
		frames: [45, 89, 90, 120],
		accuracy: { frame: 120, track: 0 },
	},
	{
		name: 'case2-stacked',
		ratio: '9:16',
		totalFrames: 180,
		tracks: stacked,
		frames: [15, 60, 119, 120, 165],
		pngAt: [2.0, 5.5],
		blackAt: [5.5],
		silentFrom: 5.1,
		accuracy: { frame: 60, track: 1 },
	},
	{
		name: 'case3-three-bands',
		ratio: '16:9',
		totalFrames: 60,
		tracks: [
			[{ at: 0, len: 60, src: 'aurora', in: 0, muted: false }],
			[{ at: 0, len: 60, src: 'fractal', in: 0, muted: false }],
			[{ at: 0, len: 60, src: 'cells', in: 0, muted: true }],
		],
		frames: [30],
		pngAt: [1.0],
		mutedCheck: true,
	},
	{
		// Not in the brief: a frame large enough for the stepwise downscale, sound at 44.1 kHz mono (resampler and
		// channel mapping), a rotated source, a split clip that continues in the same source, and a muted clip
		name: 'extra-mixed-sources',
		ratio: '9:16',
		totalFrames: 75,
		tracks: [
			[{ at: 0, len: 75, src: 'big', in: 6, muted: false }],
			[
				{ at: 0, len: 30, src: 'turned', in: 0, muted: true },
				{ at: 30, len: 30, src: 'turned', in: 30, muted: true },
			],
			[{ at: 15, len: 45, src: 'cells', in: 90, muted: false }],
		],
		frames: [7, 40, 70],
		pngAt: [1.5],
	},
	{
		// Not in the brief: a clip that asks for more than its source has. The last frame holds and the sound stops.
		name: 'extra-past-the-end',
		ratio: '16:9',
		totalFrames: 45,
		tracks: [[{ at: 0, len: 45, src: 'cells', in: 225, muted: false }]],
		frames: [5, 14, 30, 44],
		silentFrom: 0.6,
	},
	{
		// Not in the brief: one source on two tracks at once, at different places in the file
		name: 'extra-same-source-twice',
		ratio: '16:9',
		totalFrames: 30,
		tracks: [
			[{ at: 0, len: 30, src: 'cells', in: 0, muted: false }],
			[{ at: 0, len: 30, src: 'cells', in: 120, muted: false }],
		],
		frames: [3, 20],
	},
	{
		// Not in the brief: a timeline at 25 frames per second over 30 fps sources
		name: 'extra-25fps',
		ratio: '16:9',
		fps: 25,
		totalFrames: 50,
		tracks: [
			[{ at: 0, len: 40, src: 'fractal', in: 25, muted: false }],
			[{ at: 10, len: 30, src: 'cells', in: 0, muted: false }],
		],
		frames: [4, 17, 33, 45],
		accuracy: { frame: 17, track: 1 },
	},
];

const abortCases = [
	{ name: 'case4-abort', ratio: '9:16', totalFrames: 180, tracks: stacked, abortAfterMs: 300 },
	{ name: 'abort-with-reason', ratio: '9:16', totalFrames: 180, tracks: stacked, abortAfterMs: 900, abortReason: 'stopped by the check' },
	{ name: 'abort-before-start', ratio: '9:16', totalFrames: 180, tracks: stacked, abortFirst: true },
];

/** One short export per encoder a browser may lack. `deny` hides those encoders from the page. */
const fallbackSpec = {
	ratio: '9:16',
	totalFrames: 60,
	tracks: [
		[{ at: 0, len: 45, src: 'aurora', in: 30, muted: false }],
		[{ at: 15, len: 45, src: 'fractal', in: 0, muted: false }],
	],
	frames: [5, 30, 59],
};
const fallbacks = [
	{ name: 'fallback-no-native-aac', deny: ['aac'], expect: { ext: 'mp4', videoCodec: 'avc', audioCodec: 'aac' } },
	{ name: 'fallback-no-h264', deny: ['avc'], expect: { ext: 'webm', videoCodec: 'vp9', audioCodec: 'opus' } },
	{ name: 'fallback-no-h264-vp9', deny: ['avc', 'vp9'], expect: { ext: 'webm', videoCodec: 'vp8', audioCodec: 'opus' } },
];

const afterAbort = {
	name: 'after-abort',
	ratio: '16:9',
	totalFrames: 45,
	tracks: [[{ at: 0, len: 30, src: 'fractal', in: 120, muted: false }]],
	frames: [10, 40],
	blackAt: [1.25],
};

// ---------------------------------------------------------------------------------------------------------------
// ffmpeg helpers

function run(command, args, { binary = false, allowFail = false } = {}) {
	const result = spawnSync(command, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 1 << 28, windowsHide: true });
	if (result.error) {
		throw new Error(`${command} could not be started: ${result.error.message}`);
	}
	if (result.status !== 0 && !allowFail) {
		throw new Error(`${command} ${args.join(' ')}\n${String(result.stderr).slice(-2000)}`);
	}
	return result.stdout;
}

const probe = (file) => JSON.parse(run('ffprobe', [
	'-v', 'error', '-count_frames', '-print_format', 'json', '-show_format', '-show_streams', file,
]));

/** Decoded sound of a file as mono 16-bit samples at PCM_RATE. */
function pcmOf(file) {
	const bytes = run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-'], { binary: true });
	return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
}

/** The mix the export should contain, made by ffmpeg from the same sources. `ignoreMute` plays muted clips too. */
function expectedPcm(spec, { ignoreMute = false } = {}) {
	const rate = rateOf(spec);
	const total = spec.totalFrames / rate;
	const segments = spec.tracks.flat().filter((seg) => ignoreMute || !seg.muted);
	if (segments.length === 0) {
		return new Int16Array(Math.round(total * PCM_RATE));
	}
	const inputs = [];
	const filters = [];
	segments.forEach((seg, k) => {
		inputs.push('-i', sources[seg.src].file);
		const length = Math.min(seg.len, spec.totalFrames - seg.at) / rate;
		filters.push(`[${k}:a]atrim=start=${seg.in / rate}:duration=${length},asetpts=PTS-STARTPTS,`
			+ `aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(seg.at / rate * 1000)}:all=1[a${k}]`);
	});
	filters.push(`${segments.map((_, k) => `[a${k}]`).join('')}amix=inputs=${segments.length}:normalize=0:duration=longest,`
		+ `apad=whole_dur=${total},atrim=0:${total}[out]`);
	const bytes = run('ffmpeg', [
		'-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]',
		'-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-',
	], { binary: true });
	return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
}

const rmsDb = (pcm, from = 0, to = pcm.length) => {
	let sum = 0;
	for (let i = from; i < to; i++) {
		sum += pcm[i] * pcm[i];
	}
	const rms = Math.sqrt(sum / Math.max(1, to - from));
	return rms === 0 ? -Infinity : 20 * Math.log10(rms / 32768);
};

/** Best normalised correlation of two signals within +-100 ms, and the lag (ms, positive = export late). */
function correlate(actual, expected) {
	const maxLag = PCM_RATE / 10;
	const length = Math.min(actual.length, expected.length);
	let best = { correlation: -Infinity, lagMs: 0 };
	for (let lag = -maxLag; lag <= maxLag; lag += 1) {
		let dot = 0;
		let a2 = 0;
		let e2 = 0;
		for (let i = Math.max(0, -lag); i < length - Math.max(0, lag); i++) {
			const a = actual[i + lag];
			const e = expected[i];
			dot += a * e;
			a2 += a * a;
			e2 += e * e;
		}
		const correlation = dot / (Math.sqrt(a2 * e2) || 1);
		if (correlation > best.correlation) {
			best = { correlation, lagMs: lag / PCM_RATE * 1000 };
		}
	}
	return best;
}

const COMPARE = { '9:16': [90, 160], '16:9': [160, 90] };

/** One frame of an exported file as small greyscale pixels. */
function grabFrame(file, index, ratio) {
	const [w, h] = COMPARE[ratio];
	return run('ffmpeg', [
		'-v', 'error', '-i', file, '-vf', `select=eq(n\\,${index}),scale=${w}:${h}:flags=area,format=gray`,
		'-frames:v', '1', '-f', 'rawvideo', '-',
	], { binary: true });
}

/**
 * The frame the export should show, composited by ffmpeg with the same rule: equal bands, highest track on top,
 * each source centre-cropped to fill its band. `shift` moves one track's source frame; `flip` reverses the bands.
 */
function expectedFrame(spec, index, { shift = {}, flip = false } = {}) {
	const [width, height] = SIZES[spec.ratio];
	const [w, h] = COMPARE[spec.ratio];
	const active = spec.tracks
		.map((track, i) => ({ i, seg: track.find((seg) => seg.at <= index && index < seg.at + seg.len) }))
		.filter((entry) => entry.seg);
	if (active.length === 0) {
		return Buffer.alloc(w * h);
	}
	const bands = active.reverse();
	if (flip) {
		bands.reverse();
	}
	const inputs = [];
	const filters = [];
	bands.forEach(({ i, seg }, k) => {
		const source = sources[seg.src];
		const top = Math.round(k * height / bands.length);
		const bandHeight = Math.round((k + 1) * height / bands.length) - top;
		const scale = Math.max(width / source.width, bandHeight / source.height);
		const cropWidth = width / scale;
		const cropHeight = bandHeight / scale;
		// Past its last frame a source keeps showing that frame
		const shown = Math.floor((seg.in + (index - seg.at) + 0.5) / rateOf(spec) * SOURCE_FPS + 1e-6);
		const frame = Math.min(source.frames - 1, Math.max(0, shown + (shift[i] ?? 0)));
		inputs.push('-i', source.file);
		filters.push(`[${k}:v]select=eq(n\\,${frame}),crop=${cropWidth}:${cropHeight}:${(source.width - cropWidth) / 2}:`
			+ `${(source.height - cropHeight) / 2}:exact=1,scale=${width}:${bandHeight}:flags=bicubic,format=yuv444p,setsar=1[b${k}]`);
	});
	const joined = bands.length > 1
		? `${bands.map((_, k) => `[b${k}]`).join('')}vstack=inputs=${bands.length}[s];[s]`
		: '[b0]';
	filters.push(`${joined}scale=${w}:${h}:flags=area,format=gray[out]`);
	return run('ffmpeg', [
		'-v', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]',
		'-frames:v', '1', '-f', 'rawvideo', '-',
	], { binary: true });
}

const difference = (a, b) => {
	const length = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < length; i++) {
		sum += Math.abs(a[i] - b[i]);
	}
	return length === 0 ? Infinity : sum / length;
};
const mean = (pixels) => pixels.reduce((sum, value) => sum + value, 0) / Math.max(1, pixels.length);

/** Names of the boxes at the top level of an MP4 file, in file order. */
function topLevelBoxes(bytes) {
	const names = [];
	for (let offset = 0; offset + 8 <= bytes.length;) {
		let size = bytes.readUInt32BE(offset);
		names.push(bytes.toString('latin1', offset + 4, offset + 8));
		if (size === 1 && offset + 16 <= bytes.length) {
			size = Number(bytes.readBigUInt64BE(offset + 8));
		}
		if (size < 8) {
			break;
		}
		offset += size;
	}
	return names;
}

// ---------------------------------------------------------------------------------------------------------------
// Processes

async function freePort(from) {
	for (let port = from; port < from + 300; port++) {
		if (reservedPorts.has(port)) {
			continue;
		}
		const free = await new Promise((done) => {
			const server = createServer();
			server.once('error', () => done(false));
			server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
		});
		if (free) {
			return port;
		}
	}
	throw new Error(`No free port from ${from}`);
}

const started = [];

function start(name, command, args, options = {}) {
	const child = spawn(command, args, { cwd: root, windowsHide: true, ...options });
	const entry = { name, child, output: '', exited: false };
	child.stdout?.on('data', (data) => { entry.output += data; });
	child.stderr?.on('data', (data) => { entry.output += data; });
	child.on('exit', () => { entry.exited = true; });
	child.on('error', (error) => { entry.output += `\n${error.message}`; entry.exited = true; });
	started.push(entry);
	return entry;
}

const isRunning = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
};

const waitUntilGone = async (pid, ms) => {
	for (const deadline = Date.now() + ms; isRunning(pid) && Date.now() < deadline;) {
		await sleep(100);
	}
	return !isRunning(pid);
};

function killTree(pid) {
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
	} else {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already gone
		}
	}
}

/**
 * Process ids of the browser this script started. Edge on Windows may hand over to a second process and let the
 * first one exit, so the browser is found by the profile folder only this script uses.
 */
function browsersUsing(profile) {
	if (process.platform !== 'win32') {
		return [];
	}
	const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
		`Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' `
		+ `-and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`,
	], { encoding: 'utf8', windowsHide: true });
	return String(result.stdout ?? '').split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Stops a process this script started (and what that process started), by process id. */
async function stop(entry) {
	const pids = new Set([entry.pid, entry.child.pid].filter(Boolean));
	if (entry.close) {
		await entry.close();
		for (const pid of pids) {
			await waitUntilGone(pid, 5000);
		}
	}
	for (const pid of entry.findPids?.() ?? []) {
		pids.add(pid);
	}
	for (const pid of pids) {
		if (isRunning(pid)) {
			killTree(pid);
			await waitUntilGone(pid, 5000);
		}
	}
}

async function waitForHttp(url, ms, entry) {
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				return response;
			}
		} catch {
			// Not listening yet
		}
		if (entry.exited && !entry.mayHandOver) {
			throw new Error(`${entry.name} exited before it answered at ${url}:\n${entry.output.slice(-2000)}`);
		}
		if (Date.now() > deadline) {
			throw new Error(`${entry.name} did not answer at ${url} within ${ms} ms:\n${entry.output.slice(-2000)}`);
		}
		await sleep(150);
	}
}

class Cdp {
	constructor(url) {
		this.socket = new WebSocket(url);
		this.nextId = 0;
		this.pending = new Map();
		this.onEvent = null;
		this.opened = new Promise((done, fail) => {
			this.socket.addEventListener('open', done, { once: true });
			this.socket.addEventListener('error', () => fail(new Error(`Could not connect to ${url}`)), { once: true });
		});
		this.socket.addEventListener('message', (event) => {
			const message = JSON.parse(event.data);
			if (message.id === undefined) {
				this.onEvent?.(message);
				return;
			}
			const waiter = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) {
				waiter?.reject(new Error(message.error.message));
			} else {
				waiter?.resolve(message.result);
			}
		});
		this.socket.addEventListener('close', () => {
			for (const waiter of this.pending.values()) {
				waiter.reject(new Error('The browser connection closed.'));
			}
			this.pending.clear();
		});
	}

	send(method, params = {}) {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close() {
		try {
			this.socket.close();
		} catch {
			// Already closed
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The run

async function main() {
	for (const tool of ['ffprobe', 'ffmpeg']) {
		run(tool, ['-version']);
	}
	if (!existsSync(edgePath)) {
		throw new Error(`Microsoft Edge was not found at ${edgePath}. Set EDGE_PATH.`);
	}
	rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	mkdirSync(join(outDir, 'src'), { recursive: true });

	console.log('Making the extra test sources');
	run('ffmpeg', [
		'-v', 'error', '-y', '-i', sources.aurora.file, '-t', '3', '-vf', 'scale=2560:1440:flags=lanczos',
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '60',
		'-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '96k', sources.big.file,
	]);
	run('ffmpeg', [
		'-v', 'error', '-y', '-display_rotation', '90', '-i', sources.fractal.file, '-t', '3', '-c', 'copy',
		sources.turned.file,
	]);

	// A config of our own, so this server keeps its dependency cache away from a dev server that may be running
	const configFile = join(outDir, 'vite.check.config.mjs');
	writeFileSync(configFile, [
		`import { mergeConfig } from 'vite';`,
		`import base from ${JSON.stringify(pathToFileURL(join(root, 'vite.config.js')).href)};`,
		`export default async (env) => mergeConfig(typeof base === 'function' ? await base(env) : base, {`,
		`\troot: ${JSON.stringify(root)},`,
		`\tcacheDir: ${JSON.stringify(join(outDir, '.vite'))},`,
		`\tserver: { host: '127.0.0.1', hmr: false, watch: null },`,
		// Only this page is scanned: the rest of the app is being written and need not load for this check
		`\toptimizeDeps: { entries: ['tools/export-check.html'], include: ['mediabunny', '@mediabunny/aac-encoder'] },`,
		`\tclearScreen: false,`,
		`});`,
		'',
	].join('\n'));

	const vitePort = await freePort(47861);
	console.log(`Starting Vite on port ${vitePort}`);
	const vite = start('Vite', process.execPath, [
		join(root, 'node_modules/vite/bin/vite.js'), '--config', configFile, '--port', String(vitePort), '--strictPort',
	], { stdio: ['ignore', 'pipe', 'pipe'] });
	const pageUrl = `http://127.0.0.1:${vitePort}/tools/export-check.html`
		+ (process.env.MODULE ? `?module=${encodeURIComponent(`/${process.env.MODULE.replace(/^\/+/, '')}`)}` : '');
	await waitForHttp(pageUrl, 60000, vite);

	const debugPort = await freePort(vitePort + 1);
	const profile = join(outDir, 'edge-profile');
	const extraFlags = (process.env.EDGE_FLAGS ?? '').split(' ').filter(Boolean);
	console.log(`Starting headless Edge (debug port ${debugPort})${extraFlags.length ? ` with ${extraFlags.join(' ')}` : ''}`);
	const edge = start('Edge', edgePath, [
		'--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
		'--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
		'--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
		'--disable-backgrounding-occluded-windows', ...extraFlags, 'about:blank',
	], { stdio: 'ignore' });
	edge.mayHandOver = true;
	edge.findPids = () => browsersUsing(profile);
	const version = await (await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 30000, edge)).json();
	const browser = new Cdp(version.webSocketDebuggerUrl);
	await browser.opened;
	const { processInfo } = await browser.send('SystemInfo.getProcessInfo');
	edge.pid = processInfo.find((entry) => entry.type === 'browser')?.id;
	edge.close = async () => {
		try {
			await withTimeout(browser.send('Browser.close'), 3000, 'closing Edge');
		} catch {
			// It is stopped by process id below
		}
		browser.close();
	};
	const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
	const target = targets.find((entry) => entry.type === 'page');
	if (!target) {
		throw new Error('Edge has no page to drive.');
	}
	const cdp = new Cdp(target.webSocketDebuggerUrl);
	await cdp.opened;
	cdp.onEvent = (message) => {
		if (message.method === 'Runtime.consoleAPICalled') {
			pageLog.push(`[${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
		} else if (message.method === 'Runtime.exceptionThrown') {
			const details = message.params.exceptionDetails;
			pageLog.push(`[exception] ${details.exception?.description ?? details.text}`);
		} else if (message.method === 'Log.entryAdded') {
			pageLog.push(`[${message.params.entry.level}] ${message.params.entry.text} ${message.params.entry.url ?? ''}`);
		}
	};
	await cdp.send('Runtime.enable');
	await cdp.send('Log.enable');
	await cdp.send('Page.enable');

	const evaluate = async (expression, ms = 30000) => {
		const reply = await withTimeout(
			cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
			ms,
			expression.slice(0, 100),
		);
		if (reply.exceptionDetails) {
			throw new Error(`Page error: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
		}
		return reply.result.value;
	};
	let denied = '';
	const pageReady = async () => {
		const deadline = Date.now() + 90000;
		for (;;) {
			try {
				if (await evaluate(`window.__ready === true && window.__denied === ${JSON.stringify(denied)}`, 5000)) {
					return;
				}
			} catch {
				// Still loading, or reloading after Vite prepared a dependency
			}
			if (Date.now() > deadline) {
				throw new Error('The check page did not become ready.');
			}
			await sleep(250);
		}
	};
	/** Runs a case in the page; once more if the page reloaded under it. */
	const runCase = async (spec) => {
		const pageSpec = {
			...spec,
			sources: Object.fromEntries(Object.entries(sources).filter(([, source]) => source.url).map(([id, source]) => [id, source.url])),
		};
		for (let attempt = 0; ; attempt++) {
			try {
				return await evaluate(`window.runCase(${JSON.stringify(pageSpec)})`, 300000);
			} catch (error) {
				if (attempt === 0 && /context|navigat|Cannot find|destroyed/i.test(error.message)) {
					notes.push(`${spec.name}: the page reloaded once (${error.message}); ran it again`);
					await pageReady();
					continue;
				}
				throw error;
			}
		}
	};
	const pull = async (name, size, file) => {
		const chunks = [];
		const step = 1 << 20;
		for (let offset = 0; offset < size; offset += step) {
			chunks.push(Buffer.from(await evaluate(`window.readResult(${JSON.stringify(name)}, ${offset}, ${step})`), 'base64'));
		}
		const bytes = Buffer.concat(chunks);
		if (bytes.length !== size) {
			throw new Error(`${name}: read ${bytes.length} bytes of ${size}`);
		}
		writeFileSync(file, bytes);
		await evaluate(`window.dropResult(${JSON.stringify(name)})`);
	};

	let finished = false;
	try {
		await cdp.send('Page.navigate', { url: pageUrl });
		await pageReady();
		const capabilities = await evaluate('window.capabilities');
		console.log(`Browser: ${capabilities.userAgent}`);
		console.log(`Encoders: H.264 ${capabilities.avc}, AAC (native) ${capabilities.aacNative}, VP9 ${capabilities.vp9}, `
			+ `VP8 ${capabilities.vp8}, Opus ${capabilities.opus}`);

		const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
		const wanted = (spec) => !only || only.has(spec.name);
		const speeds = [];

		const exportAndCheck = async (spec) => {
			console.log(`\n${spec.name}`);
			const result = await runCase(spec);
			if (!result.ok) {
				check('export finished', false, `${result.errorName}: ${result.errorMessage}`);
				return;
			}
			const [width, height] = SIZES[spec.ratio];
			const rate = rateOf(spec);
			const seconds = spec.totalFrames / rate;
			const file = join(outDir, `${spec.name}.${result.ext}`);
			await pull(spec.name, result.size, file);
			speeds.push({ name: spec.name, frames: result.frames, seconds: result.ms / 1000, speed: result.framesPerSecond, codec: `${result.videoCodec}+${result.audioCodec} .${result.ext}`, size: result.size, rate });
			const at = result.progress.at;
			console.log(`  preparing ${Math.round(at.Rendering ?? 0)} ms, rendering ${Math.round((at.Finishing ?? 0) - (at.Rendering ?? 0))} ms,`
				+ ` finishing ${Math.round(result.ms - (at.Finishing ?? 0))} ms`);
			if (result.profile) {
				console.log(`  profile (ms): ${Object.entries(result.profile).map(([key, value]) => `${key} ${Math.round(value)}`).join(', ')}`);
			}
			console.log(`  ${result.frames} frames in ${(result.ms / 1000).toFixed(2)} s = ${result.framesPerSecond.toFixed(1)} frames/s`
				+ ` (${(result.framesPerSecond / rate).toFixed(2)}x real time), ${result.videoCodec}+${result.audioCodec} in .${result.ext},`
				+ ` ${(result.size / 1024).toFixed(0)} KB`);

			if (spec.expect) {
				check(`falls back to ${spec.expect.videoCodec} + ${spec.expect.audioCodec} in .${spec.expect.ext}`,
					result.ext === spec.expect.ext && result.videoCodec === spec.expect.videoCodec
					&& result.audioCodec === spec.expect.audioCodec,
					`${result.videoCodec}+${result.audioCodec} in .${result.ext}`);
			}
			check('result describes the file', result.width === width && result.height === height && result.frames === spec.totalFrames
				&& result.mime === `video/${result.ext}` && result.blobType === result.mime && ['mp4', 'webm'].includes(result.ext),
			`${result.width}x${result.height}, ${result.frames} frames, ${result.mime}`);
			check('progress ran from 0 to 1 without going back', result.progress.monotonic && result.progress.inRange
				&& result.progress.first === 0 && result.progress.last === 1 && result.progress.calls >= 3,
			`${result.progress.calls} calls, labels ${result.progress.labels.join(' > ')}`);
			const calls = Object.entries(result.calls);
			const used = new Set(spec.tracks.flat().map((seg) => seg.src));
			check('getBlob called once per source', calls.length === used.size && calls.every(([, count]) => count === 1),
				calls.map(([id, count]) => `${id}:${count}`).join(' '));

			const info = probe(file);
			const videos = info.streams.filter((stream) => stream.codec_type === 'video');
			const audios = info.streams.filter((stream) => stream.codec_type === 'audio');
			check('one video and one audio stream', videos.length === 1 && audios.length === 1 && info.streams.length === 2,
				info.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`).join(' '));
			const video = videos[0] ?? {};
			const audio = audios[0] ?? {};
			check(`video is ${width}x${height}`, video.width === width && video.height === height, `${video.width}x${video.height}`);
			const [num, den] = String(video.avg_frame_rate ?? '0/1').split('/').map(Number);
			// WebM stores times in milliseconds, so only MP4 can state the rate exactly
			check(`${rate} frames per second`, Math.abs(num / den - rate) < (result.ext === 'mp4' ? 0.05 : 0.5)
				&& (result.ext !== 'mp4' || video.r_frame_rate === `${rate}/1`),
			`avg ${video.avg_frame_rate}, r ${video.r_frame_rate}`);
			check(`${spec.totalFrames} video frames`, Number(video.nb_read_frames) === spec.totalFrames, `${video.nb_read_frames}`);
			const duration = Number(info.format.duration);
			check(`duration ${seconds.toFixed(1)} s (within 0.1)`, Math.abs(duration - seconds) <= 0.1, `${duration.toFixed(3)} s`);
			if (video.duration !== undefined) {
				check('video stream duration', Math.abs(Number(video.duration) - seconds) <= 0.1, `${Number(video.duration).toFixed(3)} s`);
			}
			if (audio.duration !== undefined) {
				check('audio stream duration', Math.abs(Number(audio.duration) - seconds) <= 0.1, `${Number(audio.duration).toFixed(3)} s`);
			}
			check('audio is 48 kHz stereo', Number(audio.sample_rate) === 48000 && audio.channels === 2,
				`${audio.sample_rate} Hz, ${audio.channels} ch`);
			if (result.ext === 'mp4') {
				const boxes = topLevelBoxes(readFileSync(file));
				check('MP4 is fast start (moov before mdat)', boxes.includes('moov') && boxes.indexOf('moov') < boxes.indexOf('mdat'),
					boxes.join(' '));
			}

			// Sound: length, level, and how well it matches the same mix made by ffmpeg
			const pcm = pcmOf(file);
			const decodedSeconds = pcm.length / PCM_RATE;
			check('decoded sound lasts as long as the video', Math.abs(decodedSeconds - seconds) <= 0.1, `${decodedSeconds.toFixed(3)} s`);
			const level = rmsDb(pcm);
			const expectsSound = spec.tracks.flat().some((seg) => !seg.muted);
			if (expectsSound) {
				check('sound is not silent (mean above -60 dB)', level > -60, `${level.toFixed(1)} dB`);
				const match = correlate(pcm, expectedPcm(spec));
				check('sound matches the reference mix', match.correlation > 0.85 && Math.abs(match.lagMs) <= 30,
					`correlation ${match.correlation.toFixed(3)}, offset ${match.lagMs.toFixed(1)} ms`);
				if (spec.mutedCheck) {
					const withMuted = correlate(pcm, expectedPcm(spec, { ignoreMute: true }));
					check('the muted clip is not in the mix', match.correlation - withMuted.correlation > 0.05,
						`correlation with the muted clip added ${withMuted.correlation.toFixed(3)}`);
				}
			} else {
				check('sound is silent', level < -70, `${level.toFixed(1)} dB`);
			}
			if (spec.silentFrom !== undefined) {
				const tail = rmsDb(pcm, Math.round(spec.silentFrom * PCM_RATE));
				check(`silent from ${spec.silentFrom} s`, tail < -70, `${tail.toFixed(1)} dB`);
			}

			// Picture: every listed frame against the same composite made by ffmpeg
			for (const index of spec.frames ?? []) {
				const actual = grabFrame(file, index, spec.ratio);
				const right = difference(actual, expectedFrame(spec, index));
				const bands = spec.tracks.filter((track) => track.some((seg) => seg.at <= index && index < seg.at + seg.len)).length;
				let detail = `mean difference ${right.toFixed(2)} of 255, ${bands} band${bands === 1 ? '' : 's'}`;
				let ok = right < 8;
				if (bands > 1) {
					const flipped = difference(actual, expectedFrame(spec, index, { flip: true }));
					detail += `; bands reversed ${flipped.toFixed(2)}`;
					ok &&= flipped > 3 * right + 3;
				}
				check(`frame ${index} matches the reference composite`, ok, detail);
			}
			if (spec.accuracy) {
				// The source frame shown must be the one asked for, not a neighbour
				const { frame, track } = spec.accuracy;
				const actual = grabFrame(file, frame, spec.ratio);
				const scores = [-2, -1, 0, 1, 2].map((shift) => difference(actual, expectedFrame(spec, frame, { shift: { [track]: shift } })));
				const best = scores.indexOf(Math.min(...scores)) - 2;
				const margin = Math.min(scores[1], scores[3]) - scores[2];
				const detail = `difference by source frame offset -2..+2: ${scores.map((score) => score.toFixed(2)).join(' ')}`;
				if (Math.min(scores[1], scores[3]) - Math.min(...scores) < 0.15 && best !== 0 && Math.abs(margin) < 0.15) {
					notes.push(`${spec.name}: neighbouring source frames are too alike to tell which one frame ${frame} shows (${detail})`);
				} else {
					check(`frame ${frame} shows exactly the source frame asked for`, best === 0, detail);
				}
			}
			for (const time of spec.blackAt ?? []) {
				const pixels = run('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', '-'], { binary: true });
				const brightness = mean(pixels);
				check(`frame at ${time} s is black`, pixels.length === 4096 && brightness < 4 && Math.max(...pixels) < 12,
					`mean ${brightness.toFixed(2)}, max ${Math.max(...pixels)} of 255`);
			}
			for (const time of spec.pngAt ?? []) {
				const png = join(outDir, `${spec.name}-${time.toFixed(1)}s.png`);
				run('ffmpeg', ['-v', 'error', '-y', '-ss', String(time), '-i', file, '-frames:v', '1', png]);
				console.log(`  wrote ${png}`);
			}
		};

		for (const spec of cases.filter(wanted)) {
			await exportAndCheck(spec);
		}

		for (const spec of abortCases.filter(wanted)) {
			console.log(`\n${spec.name}`);
			const result = await runCase(spec);
			check('export was rejected', result.ok === false && result.aborted === true);
			check('rejected with the signal\'s reason', result.isSignalReason === true,
				`${result.errorName}: ${result.errorMessage}`);
			if (spec.abortReason) {
				check('the reason is the one given to abort()', result.errorMessage === spec.abortReason, result.errorMessage);
			} else {
				check('the reason is an AbortError', result.errorName === 'AbortError', result.errorName);
			}
			check('rejected promptly', result.msAfterAbort !== null && result.msAfterAbort < 1000,
				`${Math.round(result.msAfterAbort)} ms after abort, ${Math.round(result.ms)} ms after start`);
			if (spec.abortFirst) {
				check('nothing was loaded', Object.keys(result.calls).length === 0 && result.progress.calls === 0);
			}
			check('no progress after the rejection', result.progress.last === null || result.progress.last < 1,
				`last ${result.progress.last}`);
		}
		if (wanted(afterAbort)) {
			// Whatever an abort left behind must not get in the way of the next export
			await exportAndCheck(afterAbort);
		}

		// The encoders a headset may lack, hidden one set at a time: each fallback must produce a good file too
		for (const fallback of fallbacks.filter(wanted)) {
			denied = fallback.deny.join(',');
			await cdp.send('Page.navigate', { url: `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}deny=${denied}` });
			await pageReady();
			const seen = await evaluate('window.capabilities');
			console.log(`\nWith ${fallback.deny.join(' and ')} hidden the page sees: H.264 ${seen.avc}, AAC (native) ${seen.aacNative},`
				+ ` VP9 ${seen.vp9}, VP8 ${seen.vp8}, Opus ${seen.opus}`);
			await exportAndCheck({ ...fallbackSpec, name: fallback.name, expect: fallback.expect });
		}

		// An encoder that claims support and then fails must end the export with a sentence, not hang it
		if (wanted({ name: 'encoder-failure' })) {
			console.log('\nencoder-failure');
			denied = 'none';
			await cdp.send('Page.navigate', { url: `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}deny=none&break=avc` });
			await pageReady();
			const result = await runCase({ ...fallbackSpec, name: 'encoder-failure' });
			check('export was rejected', result.ok === false, result.ok ? 'it finished' : '');
			check('the error says which encoder failed', /avc video encoder of this browser failed/.test(result.errorMessage ?? ''),
				`${result.errorName}: ${result.errorMessage}`);
			check('rejected without hanging', result.ms < 20000, `${Math.round(result.ms)} ms`);
		}

		await sleep(300);
		const pageErrors = pageLog.filter((line) => /^\[(error|exception)\]/.test(line));
		console.log('');
		check('no errors in the page console', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));

		finished = true;
		console.log('\nExport speed');
		for (const entry of speeds) {
			console.log(`  ${entry.name.padEnd(22)} ${String(entry.frames).padStart(4)} frames  ${entry.seconds.toFixed(2).padStart(6)} s  `
				+ `${entry.speed.toFixed(1).padStart(6)} frames/s  ${(entry.speed / entry.rate).toFixed(2)}x real time  ${entry.codec}`);
		}
	} finally {
		if (process.env.VERBOSE || failures.length > 0 || !finished) {
			console.log('\nPage console');
			for (const line of pageLog.slice(-80)) {
				console.log(`  ${line}`);
			}
		}
		cdp.close();
	}
}

let exitCode = 0;
try {
	await withTimeout(main(), 15 * 60 * 1000, 'the whole check');
} catch (error) {
	exitCode = 1;
	console.error(`\nThe check could not be completed: ${error.stack ?? error}`);
} finally {
	for (const entry of started.reverse()) {
		await stop(entry);
	}
	try {
		rmSync(join(outDir, 'edge-profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		// The profile is scratch; a file the browser was slow to let go of can stay
	}
}
for (const note of notes) {
	console.log(`note: ${note}`);
}
if (failures.length > 0) {
	exitCode = 1;
	console.log(`\n${failures.length} check${failures.length === 1 ? '' : 's'} failed:`);
	for (const failure of failures) {
		console.log(`  - ${failure}`);
	}
} else if (exitCode === 0) {
	console.log(`\nAll checks passed. Files are in ${outDir}`);
}
process.exit(exitCode);

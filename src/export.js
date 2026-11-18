// Offline export: renders a multi-track timeline to one video file in the browser.
//
// Video: one decoder per active segment walks its source forward (mediabunny VideoSampleSink range iteration, each
// packet decoded once); every output frame is composited on a 2D canvas and handed to the encoder.
// Audio: every unmuted segment's source audio is decoded as a stream, resampled to 48 kHz stereo and summed into
// half-second chunks that are encoded between the video frames they belong to.
// Memory stays bounded: at most two decoded frames per track, one audio chunk, and the encoded file itself.

import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	BlobSource,
	BufferTarget,
	CanvasSource,
	Input,
	Mp4OutputFormat,
	Output,
	Quality,
	VideoSampleSink,
	WebMOutputFormat,
	canEncodeAudio,
	canEncodeVideo,
} from 'mediabunny';

const SIZES = { '9:16': [720, 1280], '16:9': [1280, 720] };
const SAMPLE_RATE = 48000;
const VIDEO_BITRATE = 4_000_000;
const AUDIO_BITRATE = 128_000;
const KEY_FRAME_SECONDS = 2;

/** Tolerance when comparing media timestamps, in seconds. */
const EPS = 1e-6;
/** A decoder is kept for the next clip on its track when that clip continues at most this far ahead (seconds). */
const REUSE_SECONDS = 1;
/** Decoded audio buffers this close (in output samples) to where the previous one ended are treated as contiguous. */
const SNAP_SAMPLES = 120;
/** Levels below this pass through the mix untouched; above it they bend smoothly towards full scale. */
const KNEE = 0.8;
/** The page gets a turn at least this often (milliseconds), so an XR frame loop or UI keeps running. */
const BREATHE_MS = 30;

/**
 * Renders the timeline to a video file.
 *
 * @param {object} options
 * @param {Array<Array<{at:number,len:number,src:string,in:number,muted:boolean}>>} options.tracks
 *   Index 0 is the bottom track. Segment fields are whole frames at `fps`.
 * @param {number} options.totalFrames Length of the output in frames; frames no segment covers are black and silent.
 * @param {'9:16'|'16:9'} options.ratio 720x1280 or 1280x720.
 * @param {number} [options.fps]
 * @param {(srcId: string) => Promise<Blob>} options.getBlob Called once per source id.
 * @param {(fraction: number, label: string) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal] Aborting rejects with the signal's reason.
 * @returns {Promise<{blob: Blob, ext: 'mp4'|'webm', mime: string, width: number, height: number, frames: number,
 *   videoCodec: string, audioCodec: string}>}
 */
export async function exportProject({ tracks, totalFrames, ratio, fps = 30, getBlob, onProgress, signal } = {}) {
	const size = SIZES[ratio];
	if (!size) {
		throw new Error(`Unknown aspect ratio "${ratio}". Use "9:16" or "16:9".`);
	}
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error(`The frame rate must be a positive number, not ${fps}.`);
	}
	if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
		throw new Error('There is nothing to export: the timeline is empty.');
	}
	if (typeof getBlob !== 'function') {
		throw new TypeError('getBlob must be a function that returns the source video for an id.');
	}
	if (signal?.aborted) {
		throw abortReason(signal);
	}

	const job = new ExportJob({ tracks, totalFrames, width: size[0], height: size[1], fps, getBlob, onProgress });
	let onAbort = null;
	const aborted = new Promise((_, reject) => {
		if (signal) {
			onAbort = () => reject(abortReason(signal));
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
	const work = job.run();
	work.catch(() => {}); // Once aborted, whatever the renderer trips over while it winds down is of no interest
	try {
		return await Promise.race([work, aborted]);
	} finally {
		if (onAbort) {
			signal.removeEventListener('abort', onAbort);
		}
		await job.dispose();
	}
}

const abortReason = (signal) => signal.reason ?? new DOMException('The export was aborted.', 'AbortError');

/**
 * Picks the first container and codec pair this browser can encode: H.264 + AAC in MP4, then VP9 or VP8 + Opus in
 * WebM. Browsers with H.264 but no AAC encoder get the WebAssembly AAC encoder.
 */
async function pickEncoding(width, height, fps) {
	const videoOptions = { width, height, frameRate: fps, quality: new Quality({ bitrate: VIDEO_BITRATE }) };
	const audioOptions = {
		numberOfChannels: 2,
		sampleRate: SAMPLE_RATE,
		quality: new Quality({ bitrate: AUDIO_BITRATE }),
	};
	const video = (codec) => canEncodeVideo(codec, videoOptions).catch(() => false);
	const audio = (codec) => canEncodeAudio(codec, audioOptions).catch(() => false);

	if (await video('avc')) {
		let aac = await audio('aac');
		if (!aac) {
			try {
				const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
				registerAacEncoder();
				aac = await audio('aac');
			} catch {
				// The encoder module could not be loaded; WebM is next
			}
		}
		if (aac) {
			return { ext: 'mp4', mime: 'video/mp4', video: 'avc', audio: 'aac' };
		}
	}
	if (await audio('opus')) {
		for (const codec of ['vp9', 'vp8']) {
			if (await video(codec)) {
				return { ext: 'webm', mime: 'video/webm', video: codec, audio: 'opus' };
			}
		}
	}
	throw new Error(
		`This browser cannot encode a ${width}x${height} video: no usable H.264, VP9 or VP8 encoder was found.`,
	);
}

class ExportJob {
	constructor({ tracks, totalFrames, width, height, fps, getBlob, onProgress }) {
		this.totalFrames = totalFrames;
		this.width = width;
		this.height = height;
		this.fps = fps;
		this.getBlob = getBlob;
		this.onProgress = typeof onProgress === 'function' ? onProgress : null;
		this.totalSamples = Math.round(totalFrames * SAMPLE_RATE / fps);

		/** Set once the export has ended, whichever way; everything still running stops at its next step. */
		this.dead = false;
		/** @type {Map<unknown, SourceFile>} */
		this.sources = new Map();
		this.trackStates = normalizeTracks(tracks, totalFrames).map((list) => ({
			list,
			index: 0,
			seg: null,
			cursor: null,
		}));
		this.active = [];
		this.pending = [];

		/** Unmuted segments in the order their audio starts. */
		this.audioPlan = [];
		this.audioNext = 0;
		this.audioActive = [];
		this.chunkData = null;

		this.canvas = null;
		this.context = null;
		this.scratch = new Map();
		/** Container and codecs in use: { ext, mime, video, audio }. */
		this.encoding = null;
		this.output = null;
		this.target = null;
		this.videoSource = null;
		this.audioSource = null;

		this.lastProgress = -Infinity;
		this.lastBreath = performance.now();
	}

	alive() {
		if (this.dead) {
			throw new Error('The export has ended.');
		}
	}

	progress(fraction, label, force = false) {
		if (!this.onProgress || this.dead) {
			return;
		}
		const now = performance.now();
		if (!force && now - this.lastProgress < 60) {
			return;
		}
		this.lastProgress = now;
		try {
			this.onProgress(Math.min(1, Math.max(0, fraction)), label);
		} catch {
			// A failing progress display must not cost the user the export
		}
	}

	async run() {
		const { totalFrames, width, height, fps } = this;
		this.progress(0, 'Preparing', true);

		// Open every source up front: a file that is missing or cannot be decoded should fail now, not at 80%
		const uses = new Map();
		for (const state of this.trackStates) {
			for (const seg of state.list) {
				const use = uses.get(seg.src) ?? { audio: false, lastUse: 0 };
				use.audio ||= !seg.muted;
				use.lastUse = Math.max(use.lastUse, Math.min(totalFrames, seg.at + seg.len));
				uses.set(seg.src, use);
			}
		}
		await Promise.all([...uses].map(([id, use]) => this.openSource(id, use)));
		this.alive();

		for (const state of this.trackStates) {
			for (const seg of state.list) {
				const source = this.sources.get(seg.src);
				if (seg.muted || !source.audioSink) {
					continue;
				}
				const start = Math.round(seg.at * SAMPLE_RATE / fps);
				const end = Math.min(this.totalSamples, Math.round((seg.at + seg.len) * SAMPLE_RATE / fps));
				if (end > Math.max(0, start)) {
					this.audioPlan.push({ source, start, end, time: source.base + seg.in / fps });
				}
			}
		}
		this.audioPlan.sort((a, b) => a.start - b.start);

		const encoding = this.encoding = await pickEncoding(width, height, fps);
		this.alive();

		this.canvas = createCanvas(width, height);
		this.context = this.canvas.getContext('2d', { alpha: false });
		if (!this.context) {
			throw new Error('This browser could not create a 2D canvas to render the video on.');
		}
		this.context.imageSmoothingQuality = 'high';

		this.target = new BufferTarget();
		this.output = new Output({
			format: encoding.ext === 'mp4'
				? new Mp4OutputFormat({ fastStart: 'in-memory' })
				: new WebMOutputFormat(),
			target: this.target,
		});
		this.videoSource = new CanvasSource(this.canvas, {
			codec: encoding.video,
			quality: new Quality({ bitrate: VIDEO_BITRATE }),
			keyFrameInterval: KEY_FRAME_SECONDS,
		});
		this.audioSource = new AudioSampleSource({
			codec: encoding.audio,
			quality: new Quality({ bitrate: AUDIO_BITRATE }),
		});
		this.output.addVideoTrack(this.videoSource, { frameRate: fps });
		this.output.addAudioTrack(this.audioSource);
		await this.output.start().catch((error) => {
			throw this.encodeError('The video file could not be started', error);
		});
		this.alive();

		// Audio is produced half a second at a time, just ahead of the video frames of the same stretch, so the two
		// arrive at the muxer interleaved and nothing has to wait in memory for the other track
		const chunkFrames = Math.max(1, Math.round(fps / 2));
		this.chunkData = new Float32Array(2 * (Math.ceil(chunkFrames * SAMPLE_RATE / fps) + 2));
		for (let first = 0; first < totalFrames; first += chunkFrames) {
			const end = Math.min(totalFrames, first + chunkFrames);
			await this.mixAudio(this.sampleAt(first), this.sampleAt(end));
			for (let frame = first; frame < end; frame++) {
				this.alive();
				await this.renderFrame(frame);
				this.progress(0.02 + 0.95 * (frame + 1) / totalFrames, 'Rendering');
				await this.breathe();
			}
			this.releaseSources(end);
		}

		this.alive();
		this.progress(0.98, 'Finishing', true);
		await this.output.finalize().catch((error) => {
			throw this.encodeError('The video file could not be finished', error);
		});
		this.alive();
		const blob = new Blob([this.target.buffer], { type: encoding.mime });
		this.progress(1, 'Done', true);
		return {
			blob,
			ext: encoding.ext,
			mime: encoding.mime,
			width,
			height,
			frames: totalFrames,
			videoCodec: encoding.video,
			audioCodec: encoding.audio,
		};
	}

	/** Turns a failure of an encoder or of the file writer into a sentence that says what failed. */
	encodeError(what, error) {
		if (this.dead) {
			return error;
		}
		return new Error(`${what}: ${messageOf(error)}`, { cause: error });
	}

	/** Output sample index at which a timeline frame starts. */
	sampleAt(frame) {
		return Math.min(this.totalSamples, Math.round(frame * SAMPLE_RATE / this.fps));
	}

	async openSource(id, use) {
		let blob;
		try {
			blob = await this.getBlob(id);
		} catch (error) {
			throw new Error(`Source "${id}" could not be loaded: ${messageOf(error)}`, { cause: error });
		}
		this.alive();
		if (!(blob instanceof Blob)) {
			throw new Error(`Source "${id}" is missing: there is no video file for it.`);
		}

		const source = new SourceFile(this, id, new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) }));
		source.lastUse = use.lastUse;
		this.sources.set(id, source);

		let videoTrack;
		let audioTrack;
		try {
			videoTrack = await source.input.getPrimaryVideoTrack();
			audioTrack = use.audio ? await source.input.getPrimaryAudioTrack() : null;
			source.base = Math.max(0, await source.input.getFirstTimestamp());
		} catch (error) {
			if (this.dead) {
				throw error;
			}
			throw new Error(
				`Source "${id}" could not be read; the file is damaged or in a format this browser does not know: `
				+ messageOf(error),
				{ cause: error },
			);
		}
		if (!videoTrack) {
			throw new Error(`Source "${id}" has no video in it.`);
		}
		if (!(await videoTrack.canDecode())) {
			const codec = await videoTrack.getCodec().catch(() => null);
			throw new Error(`The video of source "${id}" (${codec ?? 'unknown codec'}) cannot be decoded by this browser.`);
		}
		source.videoSink = new VideoSampleSink(videoTrack);
		if (audioTrack) {
			if (!(await audioTrack.canDecode())) {
				const codec = await audioTrack.getCodec().catch(() => null);
				throw new Error(
					`The sound of source "${id}" (${codec ?? 'unknown codec'}) cannot be decoded by this browser.`
					+ ' Mute its clips to export without it.',
				);
			}
			source.audioSink = new AudioSampleSink(audioTrack);
		}
	}

	/** Frees the file readers of sources no later frame needs. */
	releaseSources(frame) {
		for (const source of this.sources.values()) {
			if (source.input.disposed || source.lastUse > frame) {
				continue;
			}
			for (const state of this.trackStates) {
				if (state.cursor?.source === source) {
					state.cursor.close();
					state.cursor = null;
				}
			}
			source.input.dispose();
		}
	}

	async renderFrame(frame) {
		const { context, width, height, active, pending } = this;
		active.length = 0;
		pending.length = 0;
		for (const state of this.trackStates) {
			const { list } = state;
			while (state.index < list.length && list[state.index].at + list[state.index].len <= frame) {
				state.index++;
			}
			const seg = list[state.index];
			if (seg && seg.at <= frame) {
				state.seg = seg;
				active.push(state);
				pending.push(this.sampleFor(state, frame));
			}
		}
		const samples = await Promise.all(pending);
		this.alive();

		// The highest track gets the top band, the lowest the bottom one
		context.fillStyle = '#000';
		context.fillRect(0, 0, width, height);
		const count = active.length;
		for (let i = 0; i < count; i++) {
			const sample = samples[i];
			if (!sample) {
				continue;
			}
			const band = count - 1 - i;
			const top = Math.round(band * height / count);
			const bottom = Math.round((band + 1) * height / count);
			this.drawCover(sample, 0, top, width, bottom - top);
		}
		await this.videoSource.add(frame / this.fps, 1 / this.fps).catch((error) => {
			throw this.encodeError(`The ${this.encoding.video} video encoder of this browser failed`, error);
		});

		for (const state of active) {
			if (state.seg.at + state.seg.len === frame + 1) {
				this.segmentEnded(state);
			}
		}
	}

	/** Resolves to the decoded source frame a track shows at a timeline frame. */
	sampleFor(state, frame) {
		const { seg } = state;
		const source = this.sources.get(seg.src);
		const time = source.base + (seg.in + (frame - seg.at) + 0.5) / this.fps;
		if (state.cursor && !(state.cursor.source === source && state.cursor.reaches(time))) {
			state.cursor.close();
			state.cursor = null;
		}
		state.cursor ??= new VideoCursor(source, time);
		return state.cursor.frameAt(time);
	}

	/** Keeps a track's decoder only when its next clip carries on in the same source right away. */
	segmentEnded(state) {
		const { cursor, seg } = state;
		if (!cursor) {
			return;
		}
		const next = state.list[state.index + 1];
		const continues = next
			&& next.src === seg.src
			&& next.at - (seg.at + seg.len) <= this.fps * 2
			&& cursor.reaches(cursor.source.base + (next.in + 0.5) / this.fps);
		if (!continues) {
			cursor.close();
			state.cursor = null;
		}
	}

	/**
	 * Draws a decoded frame so that it fills the rectangle, keeping its shape and cropping the overflow equally on
	 * both sides.
	 */
	drawCover(sample, dx, dy, dw, dh) {
		const sw = sample.displayWidth;
		const sh = sample.displayHeight;
		if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) {
			return;
		}
		const scale = Math.max(dw / sw, dh / sh);
		const cw = dw / scale;
		const ch = dh / scale;
		const cx = (sw - cw) / 2;
		const cy = (sh - ch) / 2;
		const halvings = scale < 0.5 ? Math.min(3, Math.floor(Math.log2(1 / scale))) : 0;
		if (halvings === 0) {
			sample.draw(this.context, cx, cy, cw, ch, dx, dy, dw, dh);
			return;
		}

		// Shrinking to less than half size in one step skips source pixels and makes fine detail shimmer. Draw at
		// a power-of-two multiple of the final size instead and halve from there.
		let w = dw << halvings;
		let h = dh << halvings;
		const key = `${w}x${h}`;
		let scratch = this.scratch.get(key);
		if (!scratch) {
			if (this.scratch.size >= 4) {
				this.clearScratch();
			}
			const canvas = createCanvas(w, h);
			scratch = { canvas, context: canvas.getContext('2d', { alpha: false }) };
			scratch.context.imageSmoothingQuality = 'high';
			this.scratch.set(key, scratch);
		}
		sample.draw(scratch.context, cx, cy, cw, ch, 0, 0, w, h);
		for (let level = halvings; level > 1; level--) {
			scratch.context.drawImage(scratch.canvas, 0, 0, w, h, 0, 0, w / 2, h / 2);
			w /= 2;
			h /= 2;
		}
		this.context.drawImage(scratch.canvas, 0, 0, w, h, dx, dy, dw, dh);
	}

	clearScratch() {
		for (const { canvas } of this.scratch.values()) {
			canvas.width = canvas.height = 0;
		}
		this.scratch.clear();
	}

	/** Mixes and encodes the output samples [start, end). */
	async mixAudio(start, end) {
		const length = end - start;
		if (length <= 0) {
			return;
		}
		const data = this.chunkData.subarray(0, 2 * length);
		const left = data.subarray(0, length);
		const right = data.subarray(length);
		data.fill(0);

		while (this.audioNext < this.audioPlan.length && this.audioPlan[this.audioNext].start < end) {
			this.audioActive.push(new AudioStream(this.audioPlan[this.audioNext++]));
		}
		if (this.audioActive.length > 0) {
			for (const stream of this.audioActive) {
				await stream.mixInto(left, right, start, end);
				this.alive();
			}
			let kept = 0;
			for (const stream of this.audioActive) {
				if (stream.done || stream.end <= end) {
					stream.close();
				} else {
					this.audioActive[kept++] = stream;
				}
			}
			this.audioActive.length = kept;
			softClamp(data);
		}

		const sample = new AudioSample({
			data,
			format: 'f32-planar',
			numberOfChannels: 2,
			sampleRate: SAMPLE_RATE,
			timestamp: start / SAMPLE_RATE,
		});
		try {
			await this.audioSource.add(sample);
		} catch (error) {
			throw this.encodeError(`The ${this.encoding.audio} audio encoder of this browser failed`, error);
		} finally {
			sample.close();
		}
	}

	/** Lets queued page work (rendering, input, an XR frame) run when the export has held the thread for a while. */
	async breathe() {
		const now = performance.now();
		if (now - this.lastBreath < BREATHE_MS) {
			return;
		}
		await nextTask();
		this.lastBreath = performance.now();
	}

	/** Releases decoders, file readers, the encoder and canvases. Safe to call at any point, more than once. */
	async dispose() {
		if (this.dead) {
			return;
		}
		this.dead = true;
		for (const state of this.trackStates) {
			state.cursor?.close();
			state.cursor = null;
		}
		for (const stream of this.audioActive) {
			stream.close();
		}
		this.audioActive.length = 0;
		for (const source of this.sources.values()) {
			source.input.dispose();
		}
		const { output } = this;
		if (output && output.state !== 'finalized' && output.state !== 'canceled') {
			// Closing the encoders takes a moment; an abort should not wait on it for long
			let timer;
			await Promise.race([
				output.cancel().catch(() => {}),
				new Promise((resolve) => { timer = setTimeout(resolve, 400); }),
			]);
			clearTimeout(timer);
		}
		this.clearScratch();
		if (this.canvas) {
			this.canvas.width = this.canvas.height = 0;
		}
		this.chunkData = null;
	}
}

/** One source file: its reader, its decoders' entry points and where its timeline starts. */
class SourceFile {
	constructor(job, id, input) {
		this.job = job;
		this.id = id;
		this.input = input;
		/** Timestamp of the file's first sample; source time 0 of a segment maps to it. */
		this.base = 0;
		this.videoSink = null;
		this.audioSink = null;
		/** First timeline frame after which nothing uses this source any more. */
		this.lastUse = 0;
	}

	/** Turns a decoder failure into a message that names the source. */
	decodeError(what, error) {
		if (this.job.dead) {
			return error;
		}
		return new Error(`The ${what} of source "${this.id}" could not be decoded: ${messageOf(error)}`, {
			cause: error,
		});
	}
}

/** Walks the video of one source forward and hands out the frame showing at a given time. */
class VideoCursor {
	constructor(source, startTime) {
		this.source = source;
		// Open-ended: the clip ends wherever it stops asking, and closing the iterator then closes the decoder.
		// A fixed end would flush the decoder instead, and on Chromium for Android a flush can spoil decoded
		// frames that have not been drawn yet (https://issues.chromium.org/issues/579043455).
		this.iterator = source.videoSink.samples(startTime);
		this.current = null;
		this.next = null;
		this.ended = false;
		this.closed = false;
		this.time = startTime;
	}

	/** Whether decoding on from the current position is a sensible way to get to `time`. */
	reaches(time) {
		return !this.closed && time >= this.time - EPS && time - this.time <= REUSE_SECONDS;
	}

	/**
	 * Resolves to the last frame that starts at or before `time` (the first frame if the video starts later, the
	 * last one once it has run out). The sample belongs to the cursor and is valid until the next call.
	 */
	async frameAt(time) {
		this.time = time;
		try {
			for (;;) {
				if (!this.next && !this.ended) {
					const result = await this.iterator.next();
					if (this.closed) {
						result.value?.close();
						return null;
					}
					if (result.done) {
						this.ended = true;
					} else {
						this.next = result.value;
					}
				}
				if (this.next && (!this.current || this.next.timestamp <= time + EPS)) {
					this.current?.close();
					this.current = this.next;
					this.next = null;
					continue;
				}
				return this.current;
			}
		} catch (error) {
			throw this.source.decodeError('video', error);
		}
	}

	close() {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.iterator.return().catch(() => {});
		this.current?.close();
		this.next?.close();
		this.current = this.next = null;
	}
}

/** Decodes the sound of one segment and adds it to the mix at 48 kHz stereo. */
class AudioStream {
	constructor({ source, start, end, time }) {
		this.source = source;
		/** Output samples [start, end) are this segment's. */
		this.start = start;
		this.end = end;
		/** Source time heard at `start`. */
		this.time = time;
		this.iterator = source.audioSink.samples(time, time + (end - start) / SAMPLE_RATE);
		this.done = false;
		this.closed = false;

		// The decoded buffer being mixed
		this.planes = [];
		this.left = null;
		this.right = null;
		this.length = 0;
		/** Output sample index (fractional unless the source is at 48 kHz) of the buffer's first sample. */
		this.position = 0;
		/** Output samples per source sample. */
		this.step = 1;
		/** Where the next buffer starts if it follows this one without a gap. */
		this.expected = NaN;
		// Last sample of the previous buffer, for interpolating across the seam
		this.hasPrevious = false;
		this.previousLeft = 0;
		this.previousRight = 0;
	}

	/** Adds this segment's part of the output samples [from, to) to the chunk buffers, whose index 0 is `from`. */
	async mixInto(outLeft, outRight, from, to) {
		try {
			while (!this.done) {
				if (this.length === 0) {
					const result = await this.iterator.next();
					if (this.closed) {
						result.value?.close();
						return;
					}
					if (result.done) {
						this.done = true;
						return;
					}
					try {
						this.load(result.value);
					} finally {
						result.value.close();
					}
					if (this.length === 0) {
						continue;
					}
				}
				const bufferEnd = this.mix(outLeft, outRight, from, to);
				if (bufferEnd > to) {
					return; // The rest of this buffer belongs to the next chunk
				}
				this.previousLeft = this.left[this.length - 1];
				this.previousRight = this.right[this.length - 1];
				this.hasPrevious = true;
				this.length = 0;
				if (bufferEnd >= this.end) {
					this.done = true;
				}
			}
		} catch (error) {
			throw this.source.decodeError('sound', error);
		}
	}

	/** Takes a decoded sample's data as two channels and works out where it sits in the output. */
	load(sample) {
		const frames = sample.numberOfFrames;
		const channels = sample.numberOfChannels;
		const used = Math.min(channels, 6);
		while (this.planes.length < used) {
			this.planes.push(new Float32Array(0));
		}
		for (let c = 0; c < used; c++) {
			if (this.planes[c].length < frames) {
				this.planes[c] = new Float32Array(Math.max(frames, 2048));
			}
			if (frames > 0) {
				sample.copyTo(this.planes[c], { planeIndex: c, format: 'f32-planar' });
			}
		}
		downmix(this.planes, channels, frames);
		this.left = this.planes[0];
		this.right = channels > 1 ? this.planes[1] : this.planes[0];
		this.length = frames;

		this.step = SAMPLE_RATE / sample.sampleRate;
		let position = this.start + (sample.timestamp - this.time) * SAMPLE_RATE;
		if (Math.abs(position - this.expected) <= SNAP_SAMPLES) {
			// Timestamps are rounded in some containers; consecutive buffers are one continuous signal
			position = this.expected;
		} else {
			this.hasPrevious = false;
		}
		if (this.step === 1) {
			position = Math.round(position);
		}
		this.position = position;
		this.expected = position + frames * this.step;
	}

	/** Adds the loaded buffer's overlap with [from, to) and returns the output index at which the buffer ends. */
	mix(outLeft, outRight, from, to) {
		const { left, right, length, position, step } = this;
		const low = Math.max(from, this.start);
		const high = Math.min(to, this.end);

		if (step === 1) {
			const first = Math.max(low, position);
			const last = Math.min(high, position + length);
			for (let n = first; n < last; n++) {
				outLeft[n - from] += left[n - position];
				outRight[n - from] += right[n - position];
			}
			return position + length;
		}

		// Another sample rate: linear interpolation between neighbouring source samples. The stretch between the
		// previous buffer's last sample and this one's first belongs to this buffer.
		const bufferEnd = Math.ceil(position + (length - 1) * step);
		const first = Math.max(low, Math.ceil(this.hasPrevious ? position - step : position));
		const last = Math.min(high, bufferEnd);
		const perOutput = 1 / step;
		for (let n = first; n < last; n++) {
			const at = (n - position) * perOutput;
			let index = Math.floor(at);
			let fraction = at - index;
			let l0;
			let r0;
			if (index < 0) {
				l0 = this.previousLeft;
				r0 = this.previousRight;
				fraction = Math.max(0, at + 1);
				index = -1;
			} else {
				if (index > length - 2) {
					index = length - 2;
					fraction = 1;
				}
				l0 = left[index];
				r0 = right[index];
			}
			outLeft[n - from] += l0 + (left[index + 1] - l0) * fraction;
			outRight[n - from] += r0 + (right[index + 1] - r0) * fraction;
		}
		return bufferEnd;
	}

	close() {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.done = true;
		this.iterator.return().catch(() => {});
	}
}

/** Folds a decoded buffer down to two channels, in place in the first two planes. Mono stays one plane. */
function downmix(planes, channels, frames) {
	if (channels <= 2) {
		return;
	}
	const left = planes[0];
	const right = planes[1];
	if (channels === 4) {
		// Quad: front and rear pairs
		for (let i = 0; i < frames; i++) {
			left[i] = 0.5 * (left[i] + planes[2][i]);
			right[i] = 0.5 * (right[i] + planes[3][i]);
		}
		return;
	}
	// Front left, front right, centre, then (from 5.1 on) low frequency, and the surround pair
	const centre = planes[2];
	const surroundLeft = channels >= 6 ? planes[4] : channels === 5 ? planes[3] : null;
	const surroundRight = channels >= 6 ? planes[5] : channels === 5 ? planes[4] : null;
	for (let i = 0; i < frames; i++) {
		const shared = Math.SQRT1_2 * centre[i];
		left[i] += shared + (surroundLeft ? Math.SQRT1_2 * surroundLeft[i] : 0);
		right[i] += shared + (surroundRight ? Math.SQRT1_2 * surroundRight[i] : 0);
	}
}

/** Keeps the summed mix within [-1, 1]: untouched up to the knee, bending smoothly towards full scale above it. */
function softClamp(data) {
	const room = 1 - KNEE;
	for (let i = 0; i < data.length; i++) {
		const value = data[i];
		if (value > KNEE) {
			data[i] = KNEE + room * Math.tanh((value - KNEE) / room);
		} else if (value < -KNEE) {
			data[i] = -KNEE - room * Math.tanh((-value - KNEE) / room);
		} else if (value !== value) {
			data[i] = 0;
		}
	}
}

/** Copies the tracks into sorted lists of the segments that fall inside the output. */
function normalizeTracks(tracks, totalFrames) {
	return (Array.isArray(tracks) ? tracks : []).map((track) => (Array.isArray(track) ? track : [])
		.map((seg) => ({
			at: Math.round(Number(seg?.at)),
			len: Math.round(Number(seg?.len)),
			src: seg?.src,
			in: Math.max(0, Math.round(Number(seg?.in) || 0)),
			muted: Boolean(seg?.muted),
		}))
		.filter((seg) => Number.isFinite(seg.at) && seg.len > 0 && seg.at < totalFrames && seg.at + seg.len > 0
			&& seg.src !== undefined && seg.src !== null)
		.sort((a, b) => a.at - b.at));
}

function createCanvas(width, height) {
	if (typeof document !== 'undefined') {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
	return new OffscreenCanvas(width, height);
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

let taskChannel = null;
const taskWaiters = [];

/**
 * Resolves in a new task, behind the tasks already queued (timers, messages, input, a frame callback). A message
 * channel is used because nested timers have a 4 ms floor and `scheduler.yield()` would only let more urgent work in.
 */
function nextTask() {
	if (!taskChannel) {
		taskChannel = new MessageChannel();
		taskChannel.port1.onmessage = () => taskWaiters.shift()?.();
	}
	return new Promise((resolve) => {
		taskWaiters.push(resolve);
		taskChannel.port2.postMessage(0);
	});
}

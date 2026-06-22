import { describe, expect, it, vi } from "vitest";

import { AudioProcessor, softLimitOfflineMixPeaksInPlace } from "./audioEncoder";

type OfflineRenderTestHarness = AudioProcessor & {
	decodeAudioFromUrl(url: string): Promise<AudioBuffer | null>;
	getMediaDurationSec(url: string): Promise<number>;
	loadAudioFileDemuxer(audioPath: string): Promise<unknown>;
	prepareOfflineRender(
		videoUrl: string,
		trimRegions: never[],
		speedRegions: never[],
		audioRegions: never[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath?: Record<string, number>,
	): Promise<{
		mainBufferEntry: { buffer: AudioBuffer; gain: number } | null;
		companionEntries: Array<{ buffer: AudioBuffer; startDelaySec: number; gain: number }>;
	}>;
	renderAndMuxOfflineAudio(
		videoUrl: string,
		trimRegions: never[],
		speedRegions: never[],
		audioRegions: never[],
		sourceAudioFallbackPaths: string[],
		sourceAudioFallbackStartDelayMsByPath: Record<string, number> | undefined,
		muxer: unknown,
	): Promise<void>;
	processTrimOnlyAudio(
		demuxer: unknown,
		muxer: unknown,
		trimRegions: never[],
		readEndSec?: number,
	): Promise<void>;
	buildTimelineSlices(
		sourceDurationMs: number,
		trimRegions: Array<{ id: string; startMs: number; endMs: number }>,
		speedRegions: never[],
		gapsAsBlack?: boolean,
	): Array<{
		sourceStartMs: number;
		sourceEndMs: number;
		speed: number;
		silent?: boolean;
	}>;
	renderChunked(
		prepared: {
			mainBufferEntry: null;
			companionEntries: [];
			regionEntries: [];
			mutedSourceOutputRangesSec: [];
			slices: [];
			outputDurationMs: number;
			numChannels: number;
		},
		totalOutputSec: number,
		onChunk: (
			rendered: AudioBuffer,
			outputOffsetSec: number,
			chunkIndex: number,
		) => Promise<void>,
	): Promise<void>;
};

function fakeAudioBuffer(channels: Float32Array[]): AudioBuffer {
	return {
		numberOfChannels: channels.length,
		getChannelData: (channel: number) => channels[channel],
	} as AudioBuffer;
}

describe("AudioProcessor offline render preparation", () => {
	it("uses mic sidecar instead of embedded source audio when both are present", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 10, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 9.5, numberOfChannels: 1 } as AudioBuffer;

		const decodeAudioFromUrl = vi
			.spyOn(processor, "decodeAudioFromUrl")
			.mockImplementation(async (url: string) => {
				if (url === "file:///tmp/recording.mp4") {
					return mainBuffer;
				}
				if (url === "/tmp/recording.mic.wav") {
					return micBuffer;
				}
				return null;
			});
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(10);

		const prepared = await processor.prepareOfflineRender(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mp4", "/tmp/recording.mic.wav"],
		);

		expect(prepared.mainBufferEntry).toBeNull();
		expect(prepared.companionEntries).toHaveLength(1);
		expect(prepared.companionEntries[0]?.buffer).toBe(micBuffer);
		expect(prepared.companionEntries[0]?.gain).toBe(1);
		expect(decodeAudioFromUrl).not.toHaveBeenCalledWith("file:///tmp/recording.mp4");
		expect(decodeAudioFromUrl).toHaveBeenCalledWith("/tmp/recording.mic.wav");
		expect(decodeAudioFromUrl).not.toHaveBeenCalledWith("/tmp/recording.mp4");
	});

	it("does not treat a single embedded fallback path as an external sidecar", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const loadAudioFileDemuxer = vi.spyOn(processor, "loadAudioFileDemuxer");
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mp4"],
		);

		expect(loadAudioFileDemuxer).not.toHaveBeenCalled();
		expect(renderAndMuxOfflineAudio).not.toHaveBeenCalled();
	});

	it("uses recorded companion start-delay metadata instead of inferring from duration gap", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 600, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 596.5, numberOfChannels: 1 } as AudioBuffer;

		vi.spyOn(processor, "decodeAudioFromUrl").mockImplementation(async (url: string) => {
			if (url === "file:///tmp/recording.mp4") {
				return mainBuffer;
			}
			if (url === "/tmp/recording.mic.webm") {
				return micBuffer;
			}
			return null;
		});
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(600);

		const prepared = await processor.prepareOfflineRender(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mic.webm"],
			{ "/tmp/recording.mic.webm": 3_500 },
		);

		expect(prepared.companionEntries[0]?.startDelaySec).toBeCloseTo(3.5);
	});

	it("does not double-apply baked start delay metadata for browser mic WAV sidecars", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 600, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 600, numberOfChannels: 1 } as AudioBuffer;

		vi.spyOn(processor, "decodeAudioFromUrl").mockImplementation(async (url: string) => {
			if (url === "file:///tmp/recording.mp4") {
				return mainBuffer;
			}
			if (url === "/tmp/recording.mic.wav") {
				return micBuffer;
			}
			return null;
		});
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(600);

		const prepared = await processor.prepareOfflineRender(
			"file:///tmp/recording.mp4",
			[],
			[],
			[],
			["/tmp/recording.mp4", "/tmp/recording.mic.wav"],
			{ "/tmp/recording.mic.wav": 3_500 },
		);

		expect(prepared.companionEntries[0]?.startDelaySec).toBe(0);
	});

	it("rejects companion audio that is too short for the rendered source timeline", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const mainBuffer = { duration: 512.532, numberOfChannels: 2 } as AudioBuffer;
		const micBuffer = { duration: 483.637, numberOfChannels: 1 } as AudioBuffer;

		vi.spyOn(processor, "decodeAudioFromUrl").mockImplementation(async (url: string) => {
			if (url === "file:///tmp/recording.mp4") {
				return mainBuffer;
			}
			if (url === "/tmp/recording.mic.wav") {
				return micBuffer;
			}
			return null;
		});
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(512.532);

		await expect(
			processor.prepareOfflineRender(
				"file:///tmp/recording.mp4",
				[],
				[],
				[],
				["/tmp/recording.mic.wav"],
			),
		).rejects.toThrow(
			"Companion mic audio is too short for offline export: required=512.532s available=483.637s",
		);
	});

	it("avoids the single-sidecar fast path when companion timing metadata is present", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const loadAudioFileDemuxer = vi.spyOn(processor, "loadAudioFileDemuxer");
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mic.webm"],
			{ "/tmp/recording.mic.webm": 2_000 },
		);

		expect(loadAudioFileDemuxer).not.toHaveBeenCalled();
		expect(renderAndMuxOfflineAudio).toHaveBeenCalled();
	});

	it("allows the single-sidecar fast path for canonical mac mic sidecars", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const sidecarDemuxer = {
			destroy: vi.fn(),
			getMediaInfo: vi.fn().mockResolvedValue({ duration: 60 }),
		};
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(60);
		const loadAudioFileDemuxer = vi
			.spyOn(processor, "loadAudioFileDemuxer")
			.mockResolvedValue(sidecarDemuxer);
		const processTrimOnlyAudio = vi
			.spyOn(processor, "processTrimOnlyAudio")
			.mockResolvedValue();
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			{} as never,
			{} as never,
			"file:///tmp/recording.mp4",
			[],
			[],
			undefined,
			[],
			["/tmp/recording.mic.m4a"],
		);

		expect(loadAudioFileDemuxer).toHaveBeenCalledWith("/tmp/recording.mic.m4a");
		expect(processTrimOnlyAudio).toHaveBeenCalledWith(sidecarDemuxer, {}, []);
		expect(renderAndMuxOfflineAudio).not.toHaveBeenCalled();
	});

	it("rejects a single-sidecar fast path when the sidecar is too short for the source timeline", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const sidecarDemuxer = {
			destroy: vi.fn(),
			getMediaInfo: vi.fn().mockResolvedValue({ duration: 483.637 }),
		};
		vi.spyOn(processor, "getMediaDurationSec").mockResolvedValue(512.532);
		vi.spyOn(processor, "loadAudioFileDemuxer").mockResolvedValue(sidecarDemuxer);
		const processTrimOnlyAudio = vi
			.spyOn(processor, "processTrimOnlyAudio")
			.mockResolvedValue();

		await expect(
			processor.process(
				{} as never,
				{} as never,
				"file:///tmp/recording.mp4",
				[],
				[],
				undefined,
				[],
				["/tmp/recording.mic.m4a"],
			),
		).rejects.toThrow(
			"Companion mic audio is too short for fast sidecar export: required=512.532s available=483.637s",
		);

		expect(processTrimOnlyAudio).not.toHaveBeenCalled();
		expect(sidecarDemuxer.destroy).toHaveBeenCalled();
	});

	it("keeps trimmed intervals as silent slices when gaps export as black", () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;

		const slices = processor.buildTimelineSlices(
			10_000,
			[{ id: "trim-1", startMs: 2_000, endMs: 5_000 }],
			[],
			true,
		);

		expect(slices).toEqual([
			{ sourceStartMs: 0, sourceEndMs: 2_000, speed: 1, silent: false },
			{ sourceStartMs: 2_000, sourceEndMs: 5_000, speed: 1, silent: true },
			{ sourceStartMs: 5_000, sourceEndMs: 10_000, speed: 1, silent: false },
		]);
	});

	it("drops trimmed intervals entirely when gaps are not exported as black", () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;

		const slices = processor.buildTimelineSlices(
			10_000,
			[{ id: "trim-1", startMs: 2_000, endMs: 5_000 }],
			[],
			false,
		);

		expect(slices).toEqual([
			{ sourceStartMs: 0, sourceEndMs: 2_000, speed: 1 },
			{ sourceStartMs: 5_000, sourceEndMs: 10_000, speed: 1 },
		]);
	});

	it("forces the offline render path for trimmed source audio when gaps export as black", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const renderAndMuxOfflineAudio = vi
			.spyOn(processor, "renderAndMuxOfflineAudio")
			.mockResolvedValue();

		await processor.process(
			null,
			{} as never,
			"file:///tmp/recording.mp4",
			[{ id: "trim-1", startMs: 1_000, endMs: 2_000 }],
			[],
			undefined,
			[],
			[],
			undefined,
			undefined,
			undefined,
			true,
		);

		expect(renderAndMuxOfflineAudio).toHaveBeenCalledTimes(1);
		expect(renderAndMuxOfflineAudio.mock.calls[0]?.at(-1)).toBe(true);
	});

	it("soft-limits mixed peaks before encoding or WAV conversion", () => {
		const samples = new Float32Array([
			-1.6,
			-0.5,
			Number.NEGATIVE_INFINITY,
			Number.NaN,
			0,
			0.5,
			0.95,
			Number.POSITIVE_INFINITY,
			1.6,
		]);
		const changed = softLimitOfflineMixPeaksInPlace(fakeAudioBuffer([samples]));

		expect(changed).toBe(true);
		expect(samples[0]).toBeGreaterThanOrEqual(-0.986);
		expect(samples[1]).toBe(-0.5);
		expect(samples[2]).toBe(0);
		expect(samples[3]).toBe(0);
		expect(samples[5]).toBe(0.5);
		expect(samples[6]).toBeLessThan(0.95);
		expect(samples[6]).toBeGreaterThan(0.9);
		expect(samples[7]).toBe(0);
		expect(samples[8]).toBeLessThanOrEqual(0.986);
	});

	it("runs the offline mix limiter for every rendered chunk", async () => {
		const processor = new AudioProcessor() as unknown as OfflineRenderTestHarness;
		const renderedSamples = new Float32Array([1.4]);
		const renderedBuffer = fakeAudioBuffer([renderedSamples]);
		const originalOfflineAudioContext = globalThis.OfflineAudioContext;
		(
			globalThis as unknown as { OfflineAudioContext: typeof OfflineAudioContext }
		).OfflineAudioContext = class {
			constructor() {}

			startRendering() {
				return Promise.resolve(renderedBuffer);
			}
		} as unknown as typeof OfflineAudioContext;

		try {
			let observedPeak = Number.POSITIVE_INFINITY;
			await processor.renderChunked(
				{
					mainBufferEntry: null,
					companionEntries: [],
					regionEntries: [],
					mutedSourceOutputRangesSec: [],
					slices: [],
					outputDurationMs: 100,
					numChannels: 1,
				},
				0.1,
				async (rendered) => {
					observedPeak = rendered.getChannelData(0)[0] ?? 0;
				},
			);

			expect(observedPeak).toBeLessThanOrEqual(0.986);
		} finally {
			(
				globalThis as unknown as { OfflineAudioContext: typeof OfflineAudioContext }
			).OfflineAudioContext = originalOfflineAudioContext;
		}
	});
});

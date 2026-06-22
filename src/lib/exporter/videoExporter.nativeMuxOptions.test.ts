import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoExporter } from "./videoExporter";
import type { DecodedVideoInfo } from "./streamingDecoder";

const videoInfo: DecodedVideoInfo = {
	width: 1920,
	height: 1080,
	duration: 60,
	streamDuration: 60,
	frameRate: 30,
	codec: "h264",
	hasAudio: true,
	audioCodec: "aac",
	audioSampleRate: 48_000,
};

function createExporter(overrides: Record<string, unknown> = {}) {
	return new VideoExporter({
		videoUrl: "file:///recording.mp4",
		width: 1920,
		height: 1080,
		frameRate: 30,
		bitrate: 8_000_000,
		wallpaper: "#101010",
		padding: 0,
		borderRadius: 0,
		backgroundBlur: 0,
		shadowIntensity: 0,
		showShadow: false,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		experimentalNativeExport: true,
		...overrides,
	} as never) as unknown as {
		nativeExportSessionId: string | null;
		effectiveDurationSec: number;
		buildNativeAudioPlan: (videoInfo: DecodedVideoInfo) => unknown;
		finishNativeVideoExport: (
			audioPlan: {
				audioMode: "copy-source";
				audioSourcePath: string;
				audioSourceDurationSec?: number;
			},
			totalFrames: number,
		) => Promise<{ success: boolean; tempFilePath?: string; error?: string }>;
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("VideoExporter native audio mux options", () => {
	it("passes output duration to the native mux so sidecar audio can be sync-normalized", async () => {
		const nativeVideoExportFinish = vi.fn(async () => ({
			success: true,
			tempPath: "/tmp/export-final.mp4",
		}));
		vi.stubGlobal("window", {
			electronAPI: {
				nativeVideoExportFinish,
			},
		});
		const exporter = createExporter();
		exporter.nativeExportSessionId = "native-session-1";
		exporter.effectiveDurationSec = 563.546667;

		await expect(
			exporter.finishNativeVideoExport(
				{
					audioMode: "copy-source",
					audioSourcePath: "/tmp/recording.mic.m4a",
					audioSourceDurationSec: 561.450667,
				},
				16_906,
			),
		).resolves.toMatchObject({
			success: true,
			tempFilePath: "/tmp/export-final.mp4",
		});

		expect(nativeVideoExportFinish).toHaveBeenCalledWith(
			"native-session-1",
			expect.objectContaining({
				audioMode: "copy-source",
				audioSourcePath: "/tmp/recording.mic.m4a",
				outputDurationSec: 563.546667,
				audioSourceDurationSec: 561.450667,
			}),
		);
	});

	it("does not copy embedded MP4 audio when a microphone sidecar is available", () => {
		const exporter = createExporter({
			sourceAudioFallbackPaths: ["/tmp/recording.mic.m4a"],
		});

		expect(exporter.buildNativeAudioPlan(videoInfo)).toMatchObject({
			audioMode: "edited-track",
			strategy: "offline-render-fallback",
		});
	});
});

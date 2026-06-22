import { describe, expect, it } from "vitest";
import { buildWebcamReplacementSyncResult } from "./webcamReplacementSync";

describe("buildWebcamReplacementSyncResult", () => {
	it("replaces only the webcam source in camera-only mode", () => {
		const result = buildWebcamReplacementSyncResult({
			sourcePath: "/tmp/camera.mp4",
			timeOffsetMs: 250,
			mode: "camera-only",
			timelineDurationMs: 10_000,
			replacementDurationMs: 10_000,
		});

		expect(result.webcam).toEqual({
			enabled: true,
			sourcePath: "/tmp/camera.mp4",
			timeOffsetMs: 250,
		});
		expect(result.audioRegion).toBeNull();
	});

	it("starts replacement audio later when the replacement camera started after the screen capture", () => {
		const result = buildWebcamReplacementSyncResult({
			sourcePath: "/tmp/camera.mp4",
			timeOffsetMs: 750,
			mode: "camera-and-audio",
			timelineDurationMs: 10_000,
			replacementDurationMs: 12_000,
			audioTrackIndex: 2,
		});

		expect(result.audioRegion).toMatchObject({
			audioPath: "/tmp/camera.mp4",
			startMs: 750,
			endMs: 10_000,
			sourceStartMs: 0,
			trackIndex: 2,
		});
	});

	it("reads into the replacement audio when the replacement camera started before the screen capture", () => {
		const result = buildWebcamReplacementSyncResult({
			sourcePath: "/tmp/camera.mp4",
			timeOffsetMs: -1250,
			mode: "camera-and-audio",
			timelineDurationMs: 10_000,
			replacementDurationMs: 20_000,
		});

		expect(result.audioRegion).toMatchObject({
			startMs: 0,
			endMs: 10_000,
			sourceStartMs: 1250,
		});
	});

	it("keeps 24fps-style offsets in milliseconds instead of snapping to 30fps frames", () => {
		const result = buildWebcamReplacementSyncResult({
			sourcePath: "/tmp/camera-24fps.mp4",
			timeOffsetMs: 42,
			mode: "camera-and-audio",
			timelineDurationMs: 10_000,
			replacementDurationMs: 10_000,
		});

		expect(result.webcam.timeOffsetMs).toBe(42);
		expect(result.audioRegion).toMatchObject({
			startMs: 42,
			sourceStartMs: 0,
		});
	});

	it("omits audio when the selected offset leaves no timeline overlap", () => {
		const result = buildWebcamReplacementSyncResult({
			sourcePath: "/tmp/camera.mp4",
			timeOffsetMs: 12_000,
			mode: "camera-and-audio",
			timelineDurationMs: 10_000,
			replacementDurationMs: 20_000,
		});

		expect(result.audioRegion).toBeNull();
	});
});

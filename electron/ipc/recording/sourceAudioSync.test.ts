import { describe, expect, it } from "vitest";
import {
	buildRecordingAudioOnlySyncArgs,
	buildRecordingSourceAudioSyncFilter,
	getRecordingSourceAudioSyncPlan,
} from "./sourceAudioSync";

describe("getRecordingSourceAudioSyncPlan", () => {
	it("repairs slightly shorter embedded source audio instead of accepting duration drift", () => {
		const plan = getRecordingSourceAudioSyncPlan({
			videoDurationSeconds: 563.546667,
			audioDurationSeconds: 561.450667,
		});

		expect(plan).toMatchObject({
			action: "repair",
			reason: "tempo",
			driftSeconds: 2.096,
			tempoRatio: expect.closeTo(0.996281, 6),
		});
	});

	it("rejects severe short-audio mismatches instead of warping speech", () => {
		const plan = getRecordingSourceAudioSyncPlan({
			videoDurationSeconds: 35,
			audioDurationSeconds: 25,
		});

		expect(plan).toMatchObject({
			action: "reject",
			reason: "unsafe-short-audio-mismatch",
			driftSeconds: 10,
		});
	});

	it("trims longer embedded audio to the source video duration", () => {
		const plan = getRecordingSourceAudioSyncPlan({
			videoDurationSeconds: 120,
			audioDurationSeconds: 121.2,
		});

		expect(plan).toMatchObject({
			action: "repair",
			reason: "trim",
			driftSeconds: -1.2,
			tempoRatio: 1,
		});
	});
});

describe("buildRecordingSourceAudioSyncFilter", () => {
	it("builds an audio filter that produces exactly the video duration", () => {
		const filter = buildRecordingSourceAudioSyncFilter({
			videoDurationSeconds: 563.546667,
			tempoRatio: 0.996281,
		});

		expect(filter).toBe(
			"[0:a]atempo=0.996281,apad,atrim=duration=563.547,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[aout_sync]",
		);
	});
});

describe("buildRecordingAudioOnlySyncArgs", () => {
	it("builds ffmpeg args for normalizing a companion mic or system sidecar", () => {
		const args = buildRecordingAudioOnlySyncArgs({
			inputPath: "input.mic.m4a",
			outputPath: "output.mic.m4a",
			videoDurationSeconds: 120.25,
			tempoRatio: 0.998,
		});

		expect(args).toEqual([
			"-y",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			"input.mic.m4a",
			"-filter_complex",
			"[0:a]atempo=0.998000,apad,atrim=duration=120.250,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[aout_sync]",
			"-map",
			"[aout_sync]",
			"-c:a",
			"aac",
			"-b:a",
			"192k",
			"-t",
			"120.250",
			"output.mic.m4a",
		]);
	});
});

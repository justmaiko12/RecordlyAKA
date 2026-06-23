import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getRecordingEventLogPath } from "./recordingEventLog";
import {
	buildRecordingAudioOnlySyncArgs,
	buildRecordingSourceAudioSyncFilter,
	getRecordingSourceAudioSyncPlan,
	getTrustedNativeCompanionAudioSyncTelemetry,
	getTrustedNativeCompanionAudioSyncTelemetryFromEventLog,
} from "./sourceAudioSync";

describe("getRecordingSourceAudioSyncPlan", () => {
	it("pads tiny shorter embedded source audio instead of changing speech speed", () => {
		const plan = getRecordingSourceAudioSyncPlan({
			videoDurationSeconds: 563.546667,
			audioDurationSeconds: 563.146667,
		});

		expect(plan).toMatchObject({
			action: "repair",
			reason: "pad",
			driftSeconds: 0.4,
			tempoRatio: 1,
		});
	});

	it("rejects multi-second source audio shortages instead of globally warping speech", () => {
		const plan = getRecordingSourceAudioSyncPlan({
			videoDurationSeconds: 563.546667,
			audioDurationSeconds: 561.450667,
		});

		expect(plan).toMatchObject({
			action: "reject",
			reason: "unsafe-short-audio-mismatch",
			driftSeconds: 2.096,
			tempoRatio: 1,
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

describe("getTrustedNativeCompanionAudioSyncTelemetry", () => {
	it("trusts completed native mic finalization durations before ffprobe duration repair", () => {
		const telemetry = getTrustedNativeCompanionAudioSyncTelemetry({
			trackKind: "mic",
			nativeCaptureOutput: [
				'VIDEO_RECORDING_FINALIZED path="/tmp/recording.mp4" writerStatus=completed frames=58796 realFrames=58795 holdFrames=1 duration=2017.82559383 lastPts=2017.792260497',
				'MICROPHONE_RECORDING_FINALIZED path="/tmp/recording.mic.m4a" writerStatus=completed buffers=188229 duration=2017.801342292 lastPts=2017.790675625',
			].join("\n"),
		});

		expect(telemetry).toMatchObject({
			trackKind: "mic",
			videoDurationSeconds: 2017.82559383,
			audioDurationSeconds: 2017.801342292,
			videoWriterStatus: "completed",
			audioWriterStatus: "completed",
		});
		expect(
			getRecordingSourceAudioSyncPlan({
				videoDurationSeconds: telemetry?.videoDurationSeconds ?? null,
				audioDurationSeconds: telemetry?.audioDurationSeconds ?? null,
			}),
		).toMatchObject({
			action: "none",
			reason: "within-tolerance",
			driftSeconds: 0.024,
		});
	});

	it("does not use mic-only telemetry for system audio sidecars", () => {
		expect(
			getTrustedNativeCompanionAudioSyncTelemetry({
				trackKind: "system",
				nativeCaptureOutput:
					"MICROPHONE_RECORDING_FINALIZED writerStatus=completed duration=10",
			}),
		).toBeNull();
	});

	it("can recover trusted native mic finalization durations from the event log", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-sync-"));
		try {
			const videoPath = path.join(tempDir, "recording-123.mp4");
			const eventLogPath = getRecordingEventLogPath(tempDir, "123");
			await fs.writeFile(
				eventLogPath,
				[
					{
						timestamp: "2026-06-23T00:00:00.000Z",
						sessionId: "123",
						event: "native-video-recording-finalized",
						details: {
							writerStatus: "completed",
							duration: 2017.82559383,
						},
					},
					{
						timestamp: "2026-06-23T00:00:00.000Z",
						sessionId: "123",
						event: "native-microphone-recording-finalized",
						details: {
							writerStatus: "completed",
							buffers: 188229,
							duration: 2017.801342292,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n"),
				"utf8",
			);

			const telemetry =
				await getTrustedNativeCompanionAudioSyncTelemetryFromEventLog({
					videoPath,
					trackKind: "mic",
				});

			expect(telemetry).toMatchObject({
				trackKind: "mic",
				source: "event-log",
				videoDurationSeconds: 2017.82559383,
				audioDurationSeconds: 2017.801342292,
				videoWriterStatus: "completed",
				audioWriterStatus: "completed",
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildRecordingSourceAudioSyncFilter", () => {
	it("builds an audio filter that produces exactly the video duration", () => {
		const filter = buildRecordingSourceAudioSyncFilter({
			videoDurationSeconds: 563.546667,
			tempoRatio: 1,
		});

		expect(filter).toBe(
			"[0:a]apad,atrim=duration=563.547,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[aout_sync]",
		);
	});
});

describe("buildRecordingAudioOnlySyncArgs", () => {
	it("builds ffmpeg args for normalizing a companion mic or system sidecar", () => {
		const args = buildRecordingAudioOnlySyncArgs({
			inputPath: "input.mic.m4a",
			outputPath: "output.mic.m4a",
			videoDurationSeconds: 120.25,
			tempoRatio: 1,
		});

		expect(args).toEqual([
			"-y",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			"input.mic.m4a",
			"-filter_complex",
			"[0:a]apad,atrim=duration=120.250,aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[aout_sync]",
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

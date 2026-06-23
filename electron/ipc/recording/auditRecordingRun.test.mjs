import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertRecordingRunAuditPassed, auditRecordingRun } from "./auditRecordingRun.ts";

let tempDir;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-audit-"));
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeRun(events) {
	const videoPath = path.join(tempDir, "recording-123.mp4");
	const eventLogPath = path.join(tempDir, "recording-123.recordly-events.jsonl");
	await fs.writeFile(videoPath, "not-a-real-video", "utf8");
	await fs.writeFile(
		eventLogPath,
		events
			.map((entry) =>
				JSON.stringify({
					timestamp: "2026-06-17T00:00:00.000Z",
					sessionId: "123",
					...entry,
				}),
			)
			.join("\n"),
		"utf8",
	);
	await fs.writeFile(
		path.join(tempDir, "recording-123.recording-diagnostics.json"),
		JSON.stringify({
			version: 1,
			latest: {
				phase: "stop",
				expectedDurationMs: 1_200_000,
			},
		}),
		"utf8",
	);
	return videoPath;
}

async function auditRunWithHealthySourceMedia(videoPath) {
	return auditRecordingRun(videoPath, {
		probeSourceMediaDurations: async () => ({
			videoDurationSeconds: 1200,
			audioDurationSeconds: 1200,
		}),
	});
}

async function auditRunWithHealthySourceAndCompanionAudio(videoPath) {
	return auditRecordingRun(videoPath, {
		probeSourceMediaDurations: async () => ({
			videoDurationSeconds: 1200,
			audioDurationSeconds: 1200,
		}),
		probeCompanionAudioDurationSeconds: async () => 1200,
	});
}

function healthyEvents(overrides = {}) {
	const screenDuration = overrides.screenDuration ?? 1200;
	const webcamDuration = overrides.webcamDuration ?? 1199.4;
	const proofStartOffset = overrides.proofStartOffset ?? 0.033;
	const firstVisiblePts = overrides.firstVisiblePts ?? 0.033;
	const firstVisibleFrames = Math.max(2, Math.round(firstVisiblePts * 30));
	const webcamFrames = Math.round(webcamDuration * 30);
	const proofCount = overrides.proofCount ?? Math.max(3, Math.floor(webcamDuration / 3) + 1);
	const proofEvents = Array.from({ length: proofCount }, (_, index) => {
		const ratio = proofCount <= 1 ? 1 : index / (proofCount - 1);
		const acceptedPts =
			index === 0
				? proofStartOffset
				: Number(
						Math.max(
							proofStartOffset,
							proofStartOffset + ratio * (webcamDuration - proofStartOffset - 1),
						).toFixed(3),
					);
		return {
			event: "native-webcam-proof-preview-accepted",
			details: {
				count: index === 0 ? 1 : index * 30,
				sequence: index + 1,
				acceptedFrame: Math.max(2, Math.round(acceptedPts * 30)),
				acceptedPts,
			},
		};
	});
	return [
		{
			event: "native-video-first-frame-written",
			details: { frames: 1, pts: 0 },
		},
		{ event: "native-webcam-capture-started", details: { label: "Camera" } },
		{
			event: "native-webcam-first-visible-frame-written",
			details: { frames: firstVisibleFrames, pts: firstVisiblePts },
		},
		...proofEvents,
		{
			event: "native-video-recording-finalized",
			details: {
				writerStatus: "completed",
				frames: 36000,
				realFrames: 36000,
				holdFrames: 0,
				duration: screenDuration,
			},
		},
		{
			event: "native-webcam-recording-finalized",
			details: {
				writerStatus: "completed",
				frames: webcamFrames,
				duration: webcamDuration,
			},
		},
		{ event: "native-screen-recording-accepted", details: {} },
		{ event: "native-webcam-sidecar-accepted", details: {} },
	];
}

describe("auditRecordingRun", () => {
	it("passes a healthy native screen and webcam run", async () => {
		const events = healthyEvents();
		const videoPath = await writeRun(events);
		const result = await auditRunWithHealthySourceMedia(videoPath);
		const webcamFinalization = events.find(
			(entry) => entry.event === "native-webcam-recording-finalized",
		);

		expect(result.status).toBe("pass");
		expect(result.issues).toEqual([]);
		expect(result.summary.proof.count).toBeGreaterThanOrEqual(
			Math.floor(webcamFinalization.details.duration / 3),
		);
	});

	it("warns when native media is healthy but the renderer preview surface reported stale frames", async () => {
		const events = [
			...healthyEvents(),
			{
				event: "native-webcam-preview-renderer-issue",
				details: {
					surface: "teleprompter-preview",
					issue: "visible-load-stale",
					recordingActive: true,
					previewUrl: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=12",
				},
			},
		];
		const videoPath = await writeRun(events);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("warning");
		expect(result.issues).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatchObject({
			code: "native-webcam-preview-renderer-issue",
		});
		expect(result.summary.rendererPreviewIssues).toMatchObject({
			count: 1,
			first: {
				surface: "teleprompter-preview",
				issue: "visible-load-stale",
				recordingActive: true,
			},
		});
	});

	it("warns when native audio continuity needed inserted silence", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "native-audio-silence-inserted",
				details: {
					track: "mic",
					buffers: 12,
					duration: 0.256,
					totalInserted: 0.256,
					targetPts: 14.2,
					nextPts: 14.186667,
				},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("warning");
		expect(result.issues).toEqual([]);
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: "native-audio-continuity-repaired" }),
		]);
		expect(result.summary.audioContinuityRepairs).toMatchObject({
			count: 1,
			totalBuffers: 12,
			totalDurationSeconds: 0.256,
			firstTargetPtsSeconds: 14.2,
			lastTargetPtsSeconds: 14.2,
		});
	});

	it("warns when native webcam continuity needed held frames", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "native-webcam-hold-frames-inserted",
				details: {
					frames: 9,
					totalFrames: 159,
					holdFrames: 9,
					duration: 0.3,
					targetPts: 5.3,
					lastPts: 5.266667,
				},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("warning");
		expect(result.issues).toEqual([]);
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: "native-webcam-continuity-held-frames" }),
		]);
		expect(result.summary.webcamContinuityRepairs).toMatchObject({
			count: 1,
			totalFrames: 9,
			totalDurationSeconds: 0.3,
			firstTargetPtsSeconds: 5.3,
			lastTargetPtsSeconds: 5.3,
		});
	});

	it("warns when native webcam looked visually frozen long enough to review", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "native-webcam-visual-freeze-review",
				details: {
					reason: "recovered",
					stalledFor: 4.2,
					startPts: 86.5,
					endPts: 90.7,
					meanDiff: 3.9,
				},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("warning");
		expect(result.issues).toEqual([]);
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: "native-webcam-visual-freeze-review" }),
		]);
		expect(result.summary.webcamVisualFreezeReviews).toMatchObject({
			count: 1,
			totalDurationSeconds: 4.2,
			firstStartPtsSeconds: 86.5,
			firstEndPtsSeconds: 90.7,
			lastStartPtsSeconds: 86.5,
			lastEndPtsSeconds: 90.7,
		});
	});

	it("warns when native webcam cadence exceeds the requested target fps", async () => {
		const videoPath = await writeRun([
			{
				event: "native-webcam-capture-settings-resolved",
				details: {
					requestedFrameRate: 30,
					effectiveFrameRate: 30,
				},
			},
			...healthyEvents(),
			{
				event: "native-webcam-capture-stats",
				details: {
					frames: 302,
					realFrames: 302,
					holdFrames: 0,
					elapsed: 5,
					recentFps: 60.36,
					totalFps: 60.36,
					lastPts: 5.01,
				},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("warning");
		expect(result.issues).toEqual([]);
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: "native-webcam-cadence-exceeded-target" }),
		]);
		expect(result.summary.webcamCadence).toMatchObject({
			statsCount: 1,
			targetFps: 30,
			maxRecentFps: 60.36,
			maxTotalFps: 60.36,
		});
	});

	it("fails when source audio/video sync repair rejects the recording", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "recording-source-audio-sync-rejected",
				details: {
					reason: "unsafe-short-audio-mismatch",
					videoDurationSeconds: 35,
					audioDurationSeconds: 25,
					driftSeconds: 10,
				},
			},
		]);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "recording-source-audio-sync-rejected"),
		).toBe(true);
	});

	it("fails when native microphone audio stalls during recording", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "native-audio-pipeline-stalled",
				details: {
					reason: "microphone-audio-lagging-video",
					stalledFor: 5.3,
					audioVideoDrift: 5.3,
				},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("fail");
		expect(result.issues.some((issue) => issue.code === "native-audio-pipeline-stalled")).toBe(
			true,
		);
	});

	it("fails when native microphone writer finalizes without healthy buffers", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "native-microphone-recording-finalized-unhealthy",
				details: {
					writerStatus: "completed",
					buffers: 0,
					duration: 0,
					path: "/tmp/recording-123.mic.m4a",
				},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some(
				(issue) => issue.code === "native-microphone-recording-finalized-unhealthy",
			),
		).toBe(true);
	});

	it("fails when native microphone capture was requested but never wrote a first buffer", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "native-microphone-device-default",
				details: {
					requestedLabel: "",
					requestedDeviceId: "",
					available: "MacBook Air Microphone [BuiltInMicrophoneDevice]",
				},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some(
				(issue) => issue.code === "native-microphone-audio-missing-first-buffer",
			),
		).toBe(true);
	});

	it("does not require native microphone buffer proof when native mic capture fell back cleanly", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "native-microphone-capture-unavailable",
				details: {},
			},
		]);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("pass");
		expect(
			result.issues.some(
				(issue) => issue.code === "native-microphone-audio-missing-first-buffer",
			),
		).toBe(false);
	});

	it("fails when probed source media still has embedded audio duration drift", async () => {
		const videoPath = await writeRun(healthyEvents({ screenDuration: 1200 }));
		const result = await auditRecordingRun(videoPath, {
			probeSourceMediaDurations: async () => ({
				videoDurationSeconds: 1200,
				audioDurationSeconds: 1197.5,
			}),
			probeCompanionAudioDurationSeconds: async () => 1200,
		});

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "source-media-audio-duration-drift"),
		).toBe(true);
		expect(result.summary.sourceMediaDurations).toMatchObject({
			videoDurationSeconds: 1200,
			audioDurationSeconds: 1197.5,
			driftSeconds: 2.5,
			planAction: "reject",
			planReason: "unsafe-short-audio-mismatch",
		});
	});

	it("throws a finalization error for failed recording audits", () => {
		expect(() =>
			assertRecordingRunAuditPassed(
				{
					status: "fail",
					paths: {
						inputPath: "/tmp/recording-123.mp4",
						videoPath: "/tmp/recording-123.mp4",
						eventLogPath: "/tmp/recording-123.recordly-events.jsonl",
						diagnosticsPath: "/tmp/recording-123.recording-diagnostics.json",
					},
					issues: [
						{
							code: "recording-companion-audio-sync-rejected",
							message:
								"Companion mic audio/video mismatch is too large to repair safely.",
						},
					],
					warnings: [],
					summary: {},
				},
				"/tmp/recording-123.mp4",
			),
		).toThrow(
			"Recording failed native integrity audit: Companion mic audio/video mismatch is too large to repair safely. Saved file: /tmp/recording-123.mp4 Event log: /tmp/recording-123.recordly-events.jsonl",
		);
	});

	it("does not fail embedded source audio drift when a mic companion sidecar is available", async () => {
		const videoPath = await writeRun(healthyEvents({ screenDuration: 1200 }));
		await fs.writeFile(path.join(tempDir, "recording-123.mic.m4a"), "mic-sidecar", "utf8");
		const result = await auditRecordingRun(videoPath, {
			probeSourceMediaDurations: async () => ({
				videoDurationSeconds: 1200,
				audioDurationSeconds: 1197.5,
			}),
			probeCompanionAudioDurationSeconds: async () => 1200,
		});

		expect(result.status).toBe("pass");
		expect(
			result.issues.some((issue) => issue.code === "source-media-audio-duration-drift"),
		).toBe(false);
		expect(result.summary.sourceMediaDurations).toMatchObject({
			videoDurationSeconds: 1200,
			audioDurationSeconds: 1197.5,
			driftSeconds: 2.5,
			planAction: "reject",
			planReason: "unsafe-short-audio-mismatch",
			preferredAudioSource: "mic-companion",
		});
	});

	it("fails when the preferred mic companion sidecar still has audio duration drift", async () => {
		const videoPath = await writeRun(healthyEvents({ screenDuration: 1200 }));
		await fs.writeFile(path.join(tempDir, "recording-123.mic.m4a"), "mic-sidecar", "utf8");
		const result = await auditRecordingRun(videoPath, {
			probeSourceMediaDurations: async () => ({
				videoDurationSeconds: 1200,
				audioDurationSeconds: 1197.5,
			}),
			probeCompanionAudioDurationSeconds: async () => 1197.5,
		});

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "companion-mic-audio-duration-drift"),
		).toBe(true);
		expect(result.summary.companionAudioDurations).toEqual([
			expect.objectContaining({
				audioPath: path.join(tempDir, "recording-123.mic.m4a"),
				trackKind: "mic",
				videoDurationSeconds: 1200,
				audioDurationSeconds: 1197.5,
				driftSeconds: 2.5,
				planAction: "reject",
				planReason: "unsafe-short-audio-mismatch",
			}),
		]);
	});

	it("fails when companion mic audio sync repair rejects the recording", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "recording-companion-audio-sync-rejected",
				details: {
					reason: "unsafe-short-audio-mismatch",
					trackKind: "mic",
					videoDurationSeconds: 35,
					audioDurationSeconds: 25,
					driftSeconds: 10,
				},
			},
		]);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "recording-companion-audio-sync-rejected"),
		).toBe(true);
	});

	it("fails when an expected companion mic file was missing during finalization", async () => {
		const videoPath = await writeRun([
			...healthyEvents(),
			{
				event: "recording-companion-audio-missing",
				details: {
					reason: "missing-file",
					trackKind: "mic",
					audioPath: "/tmp/recording-123.mic.m4a",
				},
			},
		]);
		const result = await auditRecordingRun(videoPath, {
			probeSourceMediaDurations: async () => ({
				videoDurationSeconds: 1200,
				audioDurationSeconds: 1200,
			}),
		});

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "recording-companion-audio-missing"),
		).toBe(true);
	});

	it("fails when browser mic sidecar diagnostics report recorded chunk gaps", async () => {
		const videoPath = await writeRun(healthyEvents());
		const diagnosticsEvent = {
			timestamp: "2026-06-17T00:00:05.000Z",
			backend: "browser-store",
			phase: "mic-sidecar",
			details: {
				metadata: {
					chunkTiming: {
						status: "needs-review",
						timesliceMs: 250,
						thresholdMs: 625,
						eventCount: 3,
						recordedGapCount: 1,
						recordedGaps: [
							{
								index: 2,
								deltaMs: 2250,
								recordedElapsedMs: 2500,
							},
						],
					},
				},
			},
		};
		await fs.writeFile(
			path.join(tempDir, "recording-123.recording-diagnostics.json"),
			JSON.stringify({
				version: 1,
				createdAt: "2026-06-17T00:00:00.000Z",
				updatedAt: "2026-06-17T00:00:05.000Z",
				videoPath,
				diagnosticsPath: path.join(tempDir, "recording-123.recording-diagnostics.json"),
				events: [diagnosticsEvent],
				latest: diagnosticsEvent,
			}),
			"utf8",
		);

		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("fail");
		expect(result.issues.some((issue) => issue.code === "browser-microphone-chunk-gap")).toBe(
			true,
		);
		expect(result.summary.microphoneChunkTiming).toEqual([
			expect.objectContaining({
				status: "needs-review",
				recordedGapCount: 1,
			}),
		]);
	});

	it("fails when a browser mic sidecar has no chunk timing diagnostics", async () => {
		const videoPath = await writeRun(healthyEvents());
		await fs.writeFile(path.join(tempDir, "recording-123.mic.wav"), "mic", "utf8");

		const result = await auditRunWithHealthySourceAndCompanionAudio(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "browser-microphone-chunk-timing-missing"),
		).toBe(true);
	});

	it("fails when browser mic chunk timing evidence is too sparse for a long recording", async () => {
		const videoPath = await writeRun(healthyEvents());
		await fs.writeFile(path.join(tempDir, "recording-123.mic.wav"), "mic", "utf8");
		const diagnosticsEvent = {
			timestamp: "2026-06-17T00:00:05.000Z",
			backend: "browser-store",
			phase: "mic-sidecar",
			details: {
				metadata: {
					chunkTiming: {
						status: "ok",
						timesliceMs: 250,
						thresholdMs: 625,
						eventCount: 2,
						recordedGapCount: 0,
						recordedGaps: [],
					},
				},
			},
		};
		await fs.writeFile(
			path.join(tempDir, "recording-123.recording-diagnostics.json"),
			JSON.stringify({
				version: 1,
				createdAt: "2026-06-17T00:00:00.000Z",
				updatedAt: "2026-06-17T00:00:05.000Z",
				videoPath,
				diagnosticsPath: path.join(tempDir, "recording-123.recording-diagnostics.json"),
				events: [diagnosticsEvent],
				latest: diagnosticsEvent,
			}),
			"utf8",
		);

		const result = await auditRunWithHealthySourceAndCompanionAudio(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some(
				(issue) => issue.code === "browser-microphone-chunk-timing-too-sparse",
			),
		).toBe(true);
	});

	it("passes when browser mic chunk timing evidence is dense for the recording duration", async () => {
		const videoPath = await writeRun(healthyEvents());
		await fs.writeFile(path.join(tempDir, "recording-123.mic.wav"), "mic", "utf8");
		const diagnosticsEvent = {
			timestamp: "2026-06-17T00:00:05.000Z",
			backend: "browser-store",
			phase: "mic-sidecar",
			details: {
				metadata: {
					chunkTiming: {
						status: "ok",
						timesliceMs: 250,
						thresholdMs: 625,
						eventCount: 130,
						recordedGapCount: 0,
						recordedGaps: [],
					},
				},
			},
		};
		await fs.writeFile(
			path.join(tempDir, "recording-123.recording-diagnostics.json"),
			JSON.stringify({
				version: 1,
				createdAt: "2026-06-17T00:00:00.000Z",
				updatedAt: "2026-06-17T00:00:05.000Z",
				videoPath,
				diagnosticsPath: path.join(tempDir, "recording-123.recording-diagnostics.json"),
				events: [diagnosticsEvent],
				latest: diagnosticsEvent,
			}),
			"utf8",
		);

		const result = await auditRunWithHealthySourceAndCompanionAudio(videoPath);

		expect(result.status).toBe("pass");
		expect(result.issues).toEqual([]);
	});

	it("passes when a preview handoff is quickly re-proven by the recording helper", async () => {
		const events = healthyEvents();
		events.splice(2, 0, {
			event: "native-webcam-preview-handoff",
			details: {
				reason: "recording-start",
				acceptedProofCount: 40,
				hasVisibleWebcamFrame: true,
				captureLabel: "Camera",
				lastAcceptedProof: {
					sequence: 40,
					acceptedFrame: 120,
					acceptedPts: 4,
				},
			},
		});
		const videoPath = await writeRun(events);
		const result = await auditRunWithHealthySourceMedia(videoPath);

		expect(result.status).toBe("pass");
		expect(result.summary.previewHandoff).toMatchObject({
			present: true,
			acceptedProofCount: 40,
			hasVisibleWebcamFrame: true,
			captureLabel: "Camera",
		});
	});

	it("fails when preview handoff and recording captured different webcam labels", async () => {
		const events = healthyEvents();
		events.splice(2, 0, {
			event: "native-webcam-preview-handoff",
			details: {
				reason: "recording-start",
				acceptedProofCount: 40,
				hasVisibleWebcamFrame: true,
				captureLabel: "Justmaiko's iPhone Camera",
				lastAcceptedProof: {
					sequence: 40,
					acceptedFrame: 120,
					acceptedPts: 4,
				},
			},
		});
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(result.issues.some((issue) => issue.code === "preview-handoff-label-mismatch")).toBe(
			true,
		);
	});

	it("fails when preview handoff and recording resolved different webcam device IDs", async () => {
		const events = healthyEvents();
		events.splice(
			2,
			0,
			{
				event: "native-webcam-selection-resolved",
				details: {
					selectedDeviceId: "preview-device",
					resolvedDeviceId: "recording-device",
					resolvedLabel: "Camera",
				},
			},
			{
				event: "native-webcam-preview-handoff",
				details: {
					reason: "recording-start",
					acceptedProofCount: 40,
					hasVisibleWebcamFrame: true,
					requestedDeviceId: "preview-device",
					captureLabel: "Camera",
					lastAcceptedProof: {
						sequence: 40,
						acceptedFrame: 120,
						acceptedPts: 4,
					},
				},
			},
		);
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "preview-handoff-device-mismatch"),
		).toBe(true);
	});

	it("fails when preview handoff had not proven accepted frames before recording", async () => {
		const events = healthyEvents();
		events.splice(2, 0, {
			event: "native-webcam-preview-handoff",
			details: {
				reason: "recording-start",
				acceptedProofCount: 0,
				hasVisibleWebcamFrame: true,
				captureLabel: "Camera",
				lastAcceptedProof: null,
			},
		});
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "preview-handoff-without-prior-proof"),
		).toBe(true);
	});

	it("fails when preview handoff had not proven visible video before recording", async () => {
		const events = healthyEvents();
		events.splice(2, 0, {
			event: "native-webcam-preview-handoff",
			details: {
				reason: "recording-start",
				acceptedProofCount: 40,
				hasVisibleWebcamFrame: false,
				captureLabel: "Camera",
				lastAcceptedProof: {
					sequence: 40,
					acceptedFrame: 120,
					acceptedPts: 4,
				},
			},
		});
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some(
				(issue) => issue.code === "preview-handoff-without-prior-visible-video",
			),
		).toBe(true);
	});

	it("fails when preview handoff is not quickly re-proven by the recording helper", async () => {
		const events = healthyEvents({ proofStartOffset: 4 });
		events.splice(2, 0, {
			event: "native-webcam-preview-handoff",
			details: {
				reason: "recording-start",
				acceptedProofCount: 40,
				hasVisibleWebcamFrame: true,
				captureLabel: "Camera",
				lastAcceptedProof: {
					sequence: 40,
					acceptedFrame: 120,
					acceptedPts: 4,
				},
			},
		});
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some(
				(issue) => issue.code === "preview-handoff-reproof-started-too-late",
			),
		).toBe(true);
	});

	it("fails when preview handoff does not quickly prove visible webcam video", async () => {
		const events = healthyEvents({ firstVisiblePts: 3.4 });
		events.splice(2, 0, {
			event: "native-webcam-preview-handoff",
			details: {
				reason: "recording-start",
				acceptedProofCount: 40,
				hasVisibleWebcamFrame: true,
				captureLabel: "Camera",
				lastAcceptedProof: {
					sequence: 40,
					acceptedFrame: 120,
					acceptedPts: 4,
				},
			},
		});
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some(
				(issue) => issue.code === "preview-handoff-visible-video-started-too-late",
			),
		).toBe(true);
		expect(result.summary.previewHandoff.firstVisibleFrame).toMatchObject({
			pts: 3.4,
		});
	});

	it("fails when raw preview exists but accepted proof-preview never appears", async () => {
		const events = healthyEvents().filter(
			(entry) => entry.event !== "native-webcam-proof-preview-accepted",
		);
		events.splice(3, 0, {
			event: "native-webcam-preview-frame-written",
			details: { sequence: 1, acceptedFrame: 2, acceptedPts: 0.033 },
		});
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(result.issues.some((issue) => issue.code === "missing-accepted-proof-preview")).toBe(
			true,
		);
	});

	it("fails when screen and webcam writer durations drift too far", async () => {
		const videoPath = await writeRun(
			healthyEvents({ screenDuration: 1200, webcamDuration: 900 }),
		);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(result.issues.some((issue) => issue.code === "screen-webcam-duration-drift")).toBe(
			true,
		);
	});

	it("fails when a long webcam recording drifts by multiple visible seconds", async () => {
		const videoPath = await writeRun(
			healthyEvents({ screenDuration: 1200, webcamDuration: 1198 }),
		);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		const driftIssue = result.issues.find(
			(issue) => issue.code === "screen-webcam-duration-drift",
		);
		expect(driftIssue).toMatchObject({
			details: {
				driftSeconds: 2,
				allowedDriftSeconds: 1,
			},
		});
	});

	it("fails when accepted proof-preview frame count ends too far before webcam finalization", async () => {
		const events = healthyEvents().map((entry) => {
			if (
				entry.event === "native-webcam-proof-preview-accepted" &&
				entry.details.sequence > 1
			) {
				return {
					...entry,
					details: {
						...entry.details,
						acceptedFrame: 30_000,
						acceptedPts: 1197,
					},
				};
			}
			return entry;
		});
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "accepted-proof-frame-ended-too-early"),
		).toBe(true);
	});

	it("fails when accepted proof-preview samples are too sparse for the run duration", async () => {
		const videoPath = await writeRun(
			healthyEvents({
				screenDuration: 1200,
				webcamDuration: 1199.4,
				proofCount: 2,
			}),
		);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "accepted-proof-preview-too-sparse"),
		).toBe(true);
	});

	it("fails when accepted proof-preview samples start too late", async () => {
		const videoPath = await writeRun(
			healthyEvents({
				screenDuration: 1200,
				webcamDuration: 1199.4,
				proofStartOffset: 20,
			}),
		);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "accepted-proof-started-too-late"),
		).toBe(true);
		expect(
			result.issues.some((issue) => issue.code === "accepted-proof-frame-started-too-late"),
		).toBe(true);
	});

	it("fails when fail-closed webcam events are present", async () => {
		const events = [
			...healthyEvents(),
			{
				event: "native-webcam-proof-preview-stale",
				details: { previewStaleForMs: 15000 },
			},
		];
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(
			result.issues.some((issue) => issue.code === "native-webcam-proof-preview-stale"),
		).toBe(true);
	});

	it("fails when screen acceptance evidence is missing", async () => {
		const events = healthyEvents().filter(
			(entry) => entry.event !== "native-screen-recording-accepted",
		);
		const videoPath = await writeRun(events);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(result.issues.some((issue) => issue.code === "missing-screen-accepted-event")).toBe(
			true,
		);
	});

	it("fails when the selected webcam was not found", async () => {
		const videoPath = await writeRun([
			{
				event: "native-video-first-frame-written",
				details: { frames: 1, pts: 0 },
			},
			{
				event: "native-webcam-device-not-found",
				details: {
					requestedLabel: "Definitely Missing Camera",
					available: "MacBook Air Camera",
				},
			},
			{
				event: "native-video-recording-finalized",
				details: {
					writerStatus: "completed",
					frames: 60,
					realFrames: 60,
					holdFrames: 0,
					duration: 2,
				},
			},
		]);
		const result = await auditRecordingRun(videoPath);

		expect(result.status).toBe("fail");
		expect(result.issues.some((issue) => issue.code === "native-webcam-device-not-found")).toBe(
			true,
		);
	});
});

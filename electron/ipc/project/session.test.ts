import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("recording session sidecar resolution", () => {
	let tempRoot: string;

	async function writeEventLog(videoPath: string, events: Array<Record<string, unknown>>) {
		const eventLogPath = videoPath.replace(/\.[^.]+$/u, ".recordly-events.jsonl");
		await fs.writeFile(
			eventLogPath,
			events
				.map((entry) =>
					JSON.stringify({
						timestamp: "2026-06-17T00:00:00.000Z",
						sessionId: "1781657811579",
						...entry,
					}),
				)
				.join("\n"),
			"utf8",
		);
	}

	function healthyNativeWebcamEvents() {
		return [
			{ event: "native-video-first-frame-written", details: { frames: 1, pts: 0 } },
			{ event: "native-webcam-capture-started", details: { label: "Camera" } },
			{
				event: "native-webcam-first-visible-frame-written",
				details: { frames: 2, pts: 0.033 },
			},
			{
				event: "native-webcam-proof-preview-accepted",
				details: { count: 1, sequence: 1, acceptedFrame: 2, acceptedPts: 0.033 },
			},
			{
				event: "native-webcam-proof-preview-accepted",
				details: { count: 30, sequence: 30, acceptedFrame: 35880, acceptedPts: 1194 },
			},
			{
				event: "native-video-recording-finalized",
				details: {
					writerStatus: "completed",
					frames: 36000,
					realFrames: 36000,
					holdFrames: 0,
					duration: 1200,
				},
			},
			{
				event: "native-webcam-recording-finalized",
				details: {
					writerStatus: "completed",
					frames: 35940,
					duration: 1198,
				},
			},
			{ event: "native-screen-recording-accepted", details: {} },
			{ event: "native-webcam-sidecar-accepted", details: {} },
		];
	}

	beforeEach(async () => {
		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				getPath: () => tempRoot,
			},
		}));
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-session-"));
	});

	afterEach(async () => {
		vi.doUnmock("electron");
		vi.resetModules();
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("can skip linked webcam filename guessing during recording finalization", async () => {
		const { resolveRecordingSession } = await import("./session");
		const videoPath = path.join(tempRoot, "recording-1781657811579.mp4");
		const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");
		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "stale webcam");

		await expect(
			resolveRecordingSession(videoPath, { allowLinkedWebcamFallback: false }),
		).resolves.toEqual({
			videoPath,
			webcamPath: null,
		});
	});

	it("uses an explicit no-webcam manifest to prevent later stale sidecar relinking", async () => {
		const {
			getRecordingSessionManifestPath,
			persistRecordingSessionManifest,
			resolveRecordingSession,
		} = await import("./session");
		const videoPath = path.join(tempRoot, "recording-1781657811579.mp4");
		const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");
		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "rejected webcam");

		await persistRecordingSessionManifest({
			videoPath,
			webcamPath: null,
			timeOffsetMs: 0,
		});

		await expect(resolveRecordingSession(videoPath)).resolves.toEqual({
			videoPath,
			webcamPath: null,
			timeOffsetMs: 0,
		});

		const manifest = JSON.parse(
			await fs.readFile(getRecordingSessionManifestPath(videoPath), "utf8"),
		);
		expect(manifest).toMatchObject({
			version: 2,
			videoFileName: "recording-1781657811579.mp4",
			webcamFileName: null,
			timeOffsetMs: 0,
		});
	});

	it("still links legacy sidecars when no manifest exists and fallback is allowed", async () => {
		const { resolveRecordingSession } = await import("./session");
		const videoPath = path.join(tempRoot, "recording-1781657811579.mp4");
		const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");
		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "legacy webcam");

		await expect(resolveRecordingSession(videoPath)).resolves.toEqual({
			videoPath,
			webcamPath,
		});
	});

	it("derives a native webcam offset from paired capture stats", async () => {
		const {
			persistRecordingSessionManifest,
			resolveRecordingSession,
		} = await import("./session");
		const videoPath = path.join(tempRoot, "recording-1781657811579.mp4");
		const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");
		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "valid webcam");
		await persistRecordingSessionManifest({
			videoPath,
			webcamPath,
			timeOffsetMs: 0,
		});
		await writeEventLog(videoPath, [
			{
				timestamp: "2026-06-17T00:00:05.000Z",
				event: "native-webcam-capture-stats",
				details: { lastPts: 4.727 },
			},
			{
				timestamp: "2026-06-17T00:00:05.000Z",
				event: "native-video-capture-stats",
				details: { lastPts: 5 },
			},
			{
				timestamp: "2026-06-17T00:00:10.000Z",
				event: "native-webcam-capture-stats",
				details: { lastPts: 9.727 },
			},
			{
				timestamp: "2026-06-17T00:00:10.000Z",
				event: "native-video-capture-stats",
				details: { lastPts: 10 },
			},
			{
				timestamp: "2026-06-17T00:00:15.000Z",
				event: "native-webcam-capture-stats",
				details: { lastPts: 14.727 },
			},
			{
				timestamp: "2026-06-17T00:00:15.000Z",
				event: "native-video-capture-stats",
				details: { lastPts: 15 },
			},
		]);

		await expect(resolveRecordingSession(videoPath)).resolves.toEqual({
			videoPath,
			webcamPath,
			timeOffsetMs: 273,
		});
	});

	it("keeps an explicit non-zero manifest offset over capture-stat estimates", async () => {
		const {
			persistRecordingSessionManifest,
			resolveRecordingSession,
		} = await import("./session");
		const videoPath = path.join(tempRoot, "recording-1781657811579.mp4");
		const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");
		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "valid webcam");
		await persistRecordingSessionManifest({
			videoPath,
			webcamPath,
			timeOffsetMs: 125,
		});
		await writeEventLog(videoPath, [
			{
				timestamp: "2026-06-17T00:00:05.000Z",
				event: "native-webcam-capture-stats",
				details: { lastPts: 4.727 },
			},
			{
				timestamp: "2026-06-17T00:00:05.000Z",
				event: "native-video-capture-stats",
				details: { lastPts: 5 },
			},
		]);

		await expect(resolveRecordingSession(videoPath)).resolves.toEqual({
			videoPath,
			webcamPath,
			timeOffsetMs: 125,
		});
	});

	it("does not relink a guessed webcam sidecar when native audit evidence rejected it", async () => {
		const { resolveRecordingSession } = await import("./session");
		const videoPath = path.join(tempRoot, "recording-1781657811579.mp4");
		const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");
		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "rejected webcam");
		await writeEventLog(videoPath, [
			{ event: "native-video-first-frame-written", details: { frames: 1, pts: 0 } },
			{ event: "native-webcam-capture-started", details: { label: "Camera" } },
			{
				event: "native-webcam-sidecar-rejected",
				details: { reason: "duration-mismatch" },
			},
			{
				event: "native-video-recording-finalized",
				details: {
					writerStatus: "completed",
					frames: 900,
					realFrames: 900,
					holdFrames: 0,
					duration: 30,
				},
			},
			{ event: "native-screen-recording-accepted", details: {} },
		]);

		await expect(resolveRecordingSession(videoPath)).resolves.toEqual({
			videoPath,
			webcamPath: null,
		});
	});

	it("still links guessed webcam sidecars when native audit evidence is healthy", async () => {
		const { resolveRecordingSession } = await import("./session");
		const videoPath = path.join(tempRoot, "recording-1781657811579.mp4");
		const webcamPath = path.join(tempRoot, "recording-1781657811579-webcam.mp4");
		await fs.writeFile(videoPath, "screen");
		await fs.writeFile(webcamPath, "valid webcam");
		await writeEventLog(videoPath, healthyNativeWebcamEvents());

		await expect(resolveRecordingSession(videoPath)).resolves.toEqual({
			videoPath,
			webcamPath,
		});
	});
});

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app, ipcMain, systemPreferences } from "electron";
import {
	buildMjpegPreviewSnapshotUrl,
	buildMjpegPreviewStreamUrl,
	ensureMediaServer,
	getMediaServerBaseUrl,
	publishMjpegPreviewFrame,
	registerMjpegPreviewStream,
	unregisterMjpegPreviewStream,
} from "../../mediaServer";
import { ensureNativeCaptureHelperBinary } from "../paths/binaries";
import { emitNativeWebcamPreview } from "../recording/events";
import { parseNativeHelperOutputLine } from "../recording/nativeHelperOutput";
import { createNativeWebcamPreviewCorrelationTracker } from "../recording/nativeWebcamPreviewCorrelation";
import {
	deriveNativeWebcamPreviewFramePaths,
	resolveNativeWebcamPreviewFramePath,
} from "../recording/nativeWebcamPreviewPaths";
import { publishNativeWebcamProofPreviewFrame } from "../recording/nativeWebcamPreviewPublish";
import { createNativeWebcamPreviewRendererUpdateGate } from "../recording/nativeWebcamPreviewRender";
import {
	resolveNativeWebcamPreviewStartupTimeoutFailure,
	shouldExposeNativeWebcamPreviewProofFrame,
} from "../recording/nativeWebcamPreviewVisibility";
import { approveUserPath } from "../utils";

type NativeWebcamPreviewStartOptions = {
	webcamDeviceId?: string | null;
	webcamLabel?: string | null;
	webcamWidth?: number | null;
	webcamHeight?: number | null;
	webcamFPS?: number | null;
};

type NativeWebcamPreviewStartResult =
	| {
			success: true;
			streamUrl: string;
			snapshotUrl: string;
	  }
	| {
			success: false;
			error: string;
			details?: Record<string, unknown>;
	  };

type NativeWebcamPreviewProofSummary = {
	sequence: number;
	acceptedFrame: number;
	acceptedPts: number;
	updatedAtMs: number;
};

export type NativeWebcamPreviewSessionSummary = {
	reason: string;
	startedAtMs: number;
	stoppedAtMs: number;
	durationMs: number;
	acceptedProofCount: number;
	lastAcceptedProof: NativeWebcamPreviewProofSummary | null;
	hasVisibleWebcamFrame: boolean;
	firstVisibleWebcamFrame: Record<string, unknown> | null;
	captureStarted: Record<string, unknown> | null;
	captureLabel: string | null;
	requestedDeviceId: string | null;
	requestedLabel: string | null;
	webcamWidth: number;
	webcamHeight: number;
	webcamFPS: number;
};

type ActivePreviewSession = {
	process: ChildProcessWithoutNullStreams;
	tempDir: string;
	outputPath: string;
	previewPath: string;
	framePaths: Set<string>;
	streamId: string;
	streamUrl: string;
	lineBuffer: string;
	acceptPreviewCorrelation: ReturnType<typeof createNativeWebcamPreviewCorrelationTracker>;
	shouldEmitRendererFrame: ReturnType<typeof createNativeWebcamPreviewRendererUpdateGate>;
	startedAtMs: number;
	acceptedProofCount: number;
	lastAcceptedProof: NativeWebcamPreviewProofSummary | null;
	hasVisibleWebcamFrame: boolean;
	firstVisibleWebcamFrame: Record<string, unknown> | null;
	captureStarted: Record<string, unknown> | null;
	captureLabel: string | null;
	requestedDeviceId: string | null;
	requestedLabel: string | null;
	webcamWidth: number;
	webcamHeight: number;
	webcamFPS: number;
	settled: boolean;
	resolveStart: (result: NativeWebcamPreviewStartResult) => void;
};

const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 5_000;
const RENDERER_STOP_REASONS = new Set(["renderer-stop", "recording-start"]);
let activePreviewSession: ActivePreviewSession | null = null;

function finitePositiveInteger(value: unknown, fallback: number, max: number) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.min(max, Math.round(value))
		: fallback;
}

function settleStart(session: ActivePreviewSession, result: NativeWebcamPreviewStartResult) {
	if (session.settled) {
		return;
	}
	session.settled = true;
	session.resolveStart(result);
}

function emitPreviewStopped(session: ActivePreviewSession, details?: Record<string, unknown>) {
	emitNativeWebcamPreview({
		active: false,
		status: "stopped",
		path: session.previewPath,
		streamUrl: session.streamUrl,
		updatedAt: Date.now(),
		details,
	});
}

function summarizePreviewSession(
	session: ActivePreviewSession,
	reason: string,
	nowMs = Date.now(),
): NativeWebcamPreviewSessionSummary {
	return {
		reason,
		startedAtMs: session.startedAtMs,
		stoppedAtMs: nowMs,
		durationMs: Math.max(0, nowMs - session.startedAtMs),
		acceptedProofCount: session.acceptedProofCount,
		lastAcceptedProof: session.lastAcceptedProof,
		hasVisibleWebcamFrame: session.hasVisibleWebcamFrame,
		firstVisibleWebcamFrame: session.firstVisibleWebcamFrame,
		captureStarted: session.captureStarted,
		captureLabel: session.captureLabel,
		requestedDeviceId: session.requestedDeviceId,
		requestedLabel: session.requestedLabel,
		webcamWidth: session.webcamWidth,
		webcamHeight: session.webcamHeight,
		webcamFPS: session.webcamFPS,
	};
}

async function cleanupPreviewSessionFiles(session: ActivePreviewSession) {
	try {
		await fs.rm(session.tempDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; stale temp previews are harmless and overwritten by new sessions.
	}
}

async function waitForProcessClose(process: ChildProcessWithoutNullStreams, timeoutMs: number) {
	if (process.exitCode !== null || process.killed) {
		return;
	}

	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			if (!process.killed) {
				process.kill("SIGTERM");
			}
			resolve();
		}, timeoutMs);
		process.once("close", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

export async function stopNativeWebcamPreviewSession(reason = "stopped"): Promise<{
	success: boolean;
	stopped: boolean;
	summary?: NativeWebcamPreviewSessionSummary;
}> {
	const session = activePreviewSession;
	if (!session) {
		return { success: true, stopped: false };
	}

	activePreviewSession = null;
	const summary = summarizePreviewSession(session, reason);
	settleStart(session, {
		success: false,
		error: reason,
	});
	emitPreviewStopped(session, {
		reason,
		acceptedProofCount: summary.acceptedProofCount,
		lastAcceptedProof: summary.lastAcceptedProof,
	});
	unregisterMjpegPreviewStream(session.streamId);

	try {
		if (!session.process.killed && session.process.stdin.writable) {
			session.process.stdin.write("stop\n");
		}
		await waitForProcessClose(session.process, STOP_TIMEOUT_MS);
	} catch {
		if (!session.process.killed) {
			session.process.kill("SIGTERM");
		}
	}

	void cleanupPreviewSessionFiles(session);
	return { success: true, stopped: true, summary };
}

function stopPreviewAfterFailure(
	session: ActivePreviewSession,
	error: string,
	details?: Record<string, unknown>,
) {
	settleStart(session, { success: false, error, details });
	void stopNativeWebcamPreviewSession(error);
}

function handlePreviewHelperLine(session: ActivePreviewSession, line: string) {
	if (activePreviewSession !== session) {
		return;
	}

	const parsed = parseNativeHelperOutputLine(line);
	if (!parsed) {
		return;
	}

	if (parsed.event === "native-webcam-capture-started") {
		session.captureStarted = parsed.details;
		session.captureLabel =
			typeof parsed.details.label === "string" && parsed.details.label.trim()
				? parsed.details.label.trim()
				: null;
		return;
	}

	if (parsed.event === "native-webcam-first-visible-frame-written") {
		session.hasVisibleWebcamFrame = true;
		session.firstVisibleWebcamFrame = parsed.details;
		return;
	}

	if (parsed.event === "native-webcam-preview-frame-written") {
		const previewFramePath = resolveNativeWebcamPreviewFramePath(
			parsed.details.path,
			session.framePaths,
		);
		if (!previewFramePath) {
			stopPreviewAfterFailure(session, "native-preview-path-invalid", {
				line,
				path: parsed.details.path,
				allowedPaths: Array.from(session.framePaths),
			});
			return;
		}

		const previewDecision = session.acceptPreviewCorrelation(parsed.details);
		if (!previewDecision.accepted) {
			stopPreviewAfterFailure(session, "native-preview-correlation-invalid", {
				line,
				reason: previewDecision.reason,
				previousCorrelation: previewDecision.previous,
				correlation: previewDecision.correlation,
			});
			return;
		}

		session.acceptedProofCount += 1;
		session.lastAcceptedProof = {
			sequence: previewDecision.correlation.sequence,
			acceptedFrame: previewDecision.correlation.acceptedFrame,
			acceptedPts: previewDecision.correlation.acceptedPts,
			updatedAtMs: Date.now(),
		};

		if (
			!shouldExposeNativeWebcamPreviewProofFrame({
				hasVisibleWebcamFrame: session.hasVisibleWebcamFrame,
			})
		) {
			return;
		}

		const baseUrl = getMediaServerBaseUrl();
		if (!baseUrl) {
			stopPreviewAfterFailure(session, "native-preview-media-server-unavailable", {
				line,
			});
			return;
		}

		const publishDecision = publishNativeWebcamProofPreviewFrame({
			streamId: session.streamId,
			framePath: previewFramePath,
			sequence: previewDecision.correlation.sequence,
			publishFrame: publishMjpegPreviewFrame,
		});
		if (!publishDecision.accepted) {
			stopPreviewAfterFailure(session, "native-preview-publish-failed", {
				line,
				...publishDecision.details,
			});
			return;
		}

		const snapshotUrl = `${buildMjpegPreviewSnapshotUrl(baseUrl, session.streamId)}&seq=${previewDecision.correlation.sequence}`;
		if (session.shouldEmitRendererFrame(previewDecision.correlation.sequence)) {
			emitNativeWebcamPreview({
				active: true,
				status: "frame",
				path: previewFramePath,
				url: snapshotUrl,
				streamUrl: session.streamUrl,
				updatedAt: Date.now(),
				details: {
					...parsed.details,
					sequence: previewDecision.correlation.sequence,
					acceptedFrame: previewDecision.correlation.acceptedFrame,
					acceptedPts: previewDecision.correlation.acceptedPts,
					mode: "preview-only",
				},
			});
		}

		settleStart(session, {
			success: true,
			streamUrl: session.streamUrl,
			snapshotUrl,
		});
		return;
	}

	if (
		parsed.event === "native-webcam-device-not-found" ||
		parsed.event === "native-webcam-pipeline-stalled" ||
		parsed.event === "native-webcam-capture-disabled"
	) {
		stopPreviewAfterFailure(session, parsed.event, parsed.details);
	}
}

async function startNativeWebcamPreviewSession(
	options: NativeWebcamPreviewStartOptions = {},
): Promise<NativeWebcamPreviewStartResult> {
	if (process.platform !== "darwin") {
		return { success: false, error: "native-webcam-preview-unsupported-platform" };
	}

	await stopNativeWebcamPreviewSession("replaced");

	const cameraStatus = systemPreferences.getMediaAccessStatus("camera");
	if (cameraStatus !== "granted") {
		const granted = await systemPreferences.askForMediaAccess("camera");
		if (!granted) {
			return { success: false, error: "camera-permission-denied" };
		}
	}

	const helperPath = await ensureNativeCaptureHelperBinary();
	const tempDir = path.join(
		app.getPath("temp"),
		`recordly-native-webcam-preview-${Date.now()}-${randomUUID()}`,
	);
	await fs.mkdir(tempDir, { recursive: true });
	const outputPath = path.join(tempDir, "preview-proof.mp4");
	const previewPath = path.join(tempDir, "preview.jpg");
	const framePaths = new Set(deriveNativeWebcamPreviewFramePaths(previewPath));
	const baseUrl = await ensureMediaServer();
	const streamId = `native-preview-${randomUUID()}`;
	const streamUrl = buildMjpegPreviewStreamUrl(baseUrl, streamId);

	approveUserPath(previewPath);
	for (const framePath of framePaths) {
		approveUserPath(framePath);
	}
	registerMjpegPreviewStream(streamId, Array.from(framePaths));

	const config: Record<string, unknown> = {
		webcamPreviewOnly: true,
		capturesWebcam: true,
		webcamOutputPath: outputPath,
		webcamPreviewPath: previewPath,
		webcamWidth: finitePositiveInteger(options.webcamWidth, 1280, 3840),
		webcamHeight: finitePositiveInteger(options.webcamHeight, 720, 2160),
		webcamFPS: finitePositiveInteger(options.webcamFPS, 30, 60),
	};
	if (typeof options.webcamDeviceId === "string" && options.webcamDeviceId.trim()) {
		config.webcamDeviceId = options.webcamDeviceId.trim();
	}
	if (typeof options.webcamLabel === "string" && options.webcamLabel.trim()) {
		config.webcamLabel = options.webcamLabel.trim();
	}
	const requestedDeviceId =
		typeof config.webcamDeviceId === "string" ? config.webcamDeviceId : null;
	const requestedLabel = typeof config.webcamLabel === "string" ? config.webcamLabel : null;

	const helperProcess = spawn(helperPath, [JSON.stringify(config)], {
		cwd: tempDir,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const startPromise = new Promise<NativeWebcamPreviewStartResult>((resolve) => {
		const session: ActivePreviewSession = {
			process: helperProcess,
			tempDir,
			outputPath,
			previewPath,
			framePaths,
			streamId,
			streamUrl,
			lineBuffer: "",
			acceptPreviewCorrelation: createNativeWebcamPreviewCorrelationTracker(),
			shouldEmitRendererFrame: createNativeWebcamPreviewRendererUpdateGate(),
			startedAtMs: Date.now(),
			acceptedProofCount: 0,
			lastAcceptedProof: null,
			hasVisibleWebcamFrame: false,
			firstVisibleWebcamFrame: null,
			captureStarted: null,
			captureLabel: null,
			requestedDeviceId,
			requestedLabel,
			webcamWidth: config.webcamWidth as number,
			webcamHeight: config.webcamHeight as number,
			webcamFPS: config.webcamFPS as number,
			settled: false,
			resolveStart: resolve,
		};
		activePreviewSession = session;

		const handleOutput = (chunk: Buffer) => {
			session.lineBuffer += chunk.toString();
			const lines = session.lineBuffer.split(/\r?\n/);
			session.lineBuffer = lines.pop() ?? "";
			for (const line of lines) {
				handlePreviewHelperLine(session, line);
			}
		};

		helperProcess.stdout.on("data", handleOutput);
		helperProcess.stderr.on("data", handleOutput);
		helperProcess.once("close", () => {
			const trailingLine = session.lineBuffer.trim();
			if (trailingLine) {
				handlePreviewHelperLine(session, trailingLine);
			}
			if (activePreviewSession === session) {
				activePreviewSession = null;
				emitPreviewStopped(session, { reason: "helper-closed" });
				unregisterMjpegPreviewStream(session.streamId);
				void cleanupPreviewSessionFiles(session);
			}
			settleStart(session, { success: false, error: "native-preview-helper-closed" });
		});

		emitNativeWebcamPreview({
			active: true,
			status: "starting",
			path: previewPath,
			streamUrl,
			updatedAt: Date.now(),
			details: { mode: "preview-only" },
		});

		setTimeout(() => {
			if (activePreviewSession === session && !session.settled) {
				const failure = resolveNativeWebcamPreviewStartupTimeoutFailure({
					acceptedProofCount: session.acceptedProofCount,
					hasVisibleWebcamFrame: session.hasVisibleWebcamFrame,
					lastAcceptedProof: session.lastAcceptedProof,
					timeoutMs: START_TIMEOUT_MS,
				});
				stopPreviewAfterFailure(session, failure.error, failure.details);
			}
		}, START_TIMEOUT_MS);
	});

	return startPromise;
}

export function registerNativeWebcamPreviewHandlers() {
	ipcMain.handle("start-native-webcam-preview", async (_event, options) => {
		try {
			return await startNativeWebcamPreviewSession(
				(options ?? {}) as NativeWebcamPreviewStartOptions,
			);
		} catch (error) {
			await stopNativeWebcamPreviewSession("start-failed");
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});

	ipcMain.handle("stop-native-webcam-preview", async (_event, options) => {
		const requestedReason =
			options &&
			typeof options === "object" &&
			typeof (options as { reason?: unknown }).reason === "string"
				? (options as { reason: string }).reason
				: null;
		const reason =
			requestedReason && RENDERER_STOP_REASONS.has(requestedReason)
				? requestedReason
				: "renderer-stop";
		return stopNativeWebcamPreviewSession(reason);
	});
}

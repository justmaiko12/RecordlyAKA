import fs from "node:fs/promises";
import path from "node:path";
import {
	getFileSizeIfPresent,
	probeVideoStreamDuration,
	validateRecordedVideo,
} from "./diagnostics";
import { appendRecordingEventLogEntry } from "./recordingEventLog";

const MAX_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS = 10;
const MIN_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS = 3;
const NATIVE_WEBCAM_DURATION_DRIFT_RATIO = 0.01;
const MIN_ACCEPTABLE_WEBCAM_EFFECTIVE_FPS = 10;
const MIN_NATIVE_FRAME_COUNT_DRIFT = 15;
const NATIVE_FRAME_COUNT_DRIFT_RATIO = 0.05;
const NATIVE_WEBCAM_FAILURE_MARKERS = [
	"WEBCAM_CAPTURE_FAIL_CLOSED",
	"WEBCAM_CAPTURE_DISABLED",
	"WEBCAM_DEVICE_NOT_FOUND",
	"WEBCAM_PIPELINE_STALLED",
	"WEBCAM_VISUAL_STALL_SUSPECTED",
] as const;
const PERSISTENT_NATIVE_FAILURE_EVENTS = new Set([
	"native-helper-exited-unexpectedly",
	"native-video-capture-stats-stale",
	"native-video-stream-stopped-with-error",
	"native-video-pipeline-stalled",
	"native-audio-capture-stats-stale",
	"native-audio-pipeline-stalled",
	"native-webcam-capture-stats-stale",
	"native-webcam-capture-low-cadence-sustained",
	"native-webcam-visual-stall-fail-closed",
	"native-webcam-proof-preview-stale",
	"native-webcam-proof-preview-gap",
	"native-webcam-proof-preview-lagging",
	"native-webcam-proof-preview-invalid",
	"native-webcam-proof-preview-publish-failed",
	"native-webcam-pipeline-stalled",
	"native-webcam-capture-disabled",
	"native-webcam-device-not-found",
	"native-webcam-sidecar-rejected",
	"native-screen-recording-rejected",
	"native-screen-duration-short",
	"native-screen-duration-validation-failed",
	"recording-run-audit-failed",
	"recording-companion-audio-sync-rejected",
	"recording-companion-audio-sync-repair-failed",
	"recording-companion-audio-missing",
	"recording-source-audio-sync-rejected",
	"recording-source-audio-sync-repair-failed",
	"webcam-sidecar-normalize-failed",
	"webcam-sidecar-video-store-failed",
	"webcam-sidecar-stream-start-failed",
]);
const PERSISTENT_NATIVE_DEGRADED_REASONS = new Set([
	"webcam-sample-append-failed",
	"native-video-capture-stats-stale",
	"native-video-stream-stopped-with-error",
	"native-video-pipeline-stalled",
	"native-audio-capture-stats-stale",
	"native-audio-pipeline-stalled",
	"native-webcam-capture-stats-stale",
	"native-webcam-capture-low-cadence-sustained",
	"native-webcam-visual-stall-fail-closed",
	"native-webcam-proof-preview-stale",
	"native-webcam-proof-preview-gap",
	"native-webcam-proof-preview-lagging",
	"native-webcam-proof-preview-invalid",
	"native-webcam-proof-preview-publish-failed",
	"native-webcam-pipeline-stalled",
	"native-webcam-capture-disabled",
	"native-webcam-device-not-found",
	"native-webcam-fail-closed",
]);

type NativeWriterFinalization = {
	line: string;
	writerStatus: string | null;
	frames: number | null;
	realFrames: number | null;
	holdFrames: number | null;
	duration: number | null;
	path: string | null;
};
type PersistentNativeFailure = {
	event: string;
	line: string;
	details: Record<string, unknown> | null;
};

export function getAllowedNativeRecordingDurationDriftSeconds(durationSeconds: number) {
	return Math.min(
		MAX_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS,
		Math.max(
			MIN_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS,
			durationSeconds * NATIVE_WEBCAM_DURATION_DRIFT_RATIO,
		),
	);
}

function getRecordingSessionIdForVideoPath(videoPath: string) {
	const baseName = path.basename(videoPath, path.extname(videoPath));
	return baseName.startsWith("recording-") ? baseName.slice("recording-".length) : baseName;
}

function getRecordingEventLogPathForVideoPath(videoPath: string) {
	const baseName = path.basename(videoPath, path.extname(videoPath));
	return path.join(path.dirname(videoPath), `${baseName}.recordly-events.jsonl`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function getPersistentNativeFailureForVideoPath(
	videoPath: string,
): Promise<PersistentNativeFailure | null> {
	const eventLogPath = getRecordingEventLogPathForVideoPath(videoPath);
	let raw: string;
	try {
		raw = await fs.readFile(eventLogPath, "utf8");
	} catch {
		return null;
	}

	let latestFailure: PersistentNativeFailure | null = null;
	for (const line of raw.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (!isRecord(parsed) || typeof parsed.event !== "string") {
				continue;
			}
			const details = isRecord(parsed.details) ? parsed.details : null;
			if (parsed.event === "native-recording-degraded") {
				if (!isPersistentNativeRecordingDegraded(details)) {
					continue;
				}
				latestFailure = {
					event: parsed.event,
					line: trimmed,
					details,
				};
				continue;
			}
			if (!PERSISTENT_NATIVE_FAILURE_EVENTS.has(parsed.event)) {
				continue;
			}

			latestFailure = {
				event: parsed.event,
				line: trimmed,
				details,
			};
		} catch {
			// A malformed event log should not make an otherwise valid recording
			// unrecoverable; the audit pass separately reports parse failures.
		}
	}

	return latestFailure;
}

function isPersistentNativeRecordingDegraded(details: Record<string, unknown> | null) {
	if (!details) {
		return false;
	}
	if (details.severity === "error") {
		return true;
	}
	return (
		typeof details.reason === "string" && PERSISTENT_NATIVE_DEGRADED_REASONS.has(details.reason)
	);
}

function getNativeWebcamFailureMarker(processOutput?: string | null) {
	if (!processOutput) {
		return null;
	}

	for (const marker of NATIVE_WEBCAM_FAILURE_MARKERS) {
		const index = processOutput.indexOf(marker);
		if (index < 0) {
			continue;
		}

		const lineStart = processOutput.lastIndexOf("\n", index) + 1;
		const nextLineBreak = processOutput.indexOf("\n", index);
		const lineEnd = nextLineBreak >= 0 ? nextLineBreak : processOutput.length;
		return {
			marker,
			line: processOutput.slice(lineStart, lineEnd).trim(),
		};
	}

	return null;
}

function parseScalar(value: string) {
	const numeric = Number(value);
	return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
}

function parseKeyValueTail(tail: string) {
	const details: Record<string, unknown> = {};
	const keyValuePattern = /([a-zA-Z][a-zA-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
	let match: RegExpExecArray | null = keyValuePattern.exec(tail);
	while (match !== null) {
		const rawValue = match[2];
		const unquoted =
			(rawValue.startsWith('"') && rawValue.endsWith('"')) ||
			(rawValue.startsWith("'") && rawValue.endsWith("'"))
				? rawValue.slice(1, -1)
				: rawValue;
		details[match[1]] = parseScalar(unquoted);
		match = keyValuePattern.exec(tail);
	}
	return details;
}

function getFinitePositiveFrameCount(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.round(value)
		: null;
}

function getNativeWriterFinalization(
	processOutput?: string | null,
	prefix = "WEBCAM_RECORDING_FINALIZED ",
): NativeWriterFinalization | null {
	if (!processOutput) {
		return null;
	}

	const lines = processOutput.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim() ?? "";
		if (!line.startsWith(prefix)) {
			continue;
		}

		const details = parseKeyValueTail(line.slice(prefix.length));
		return {
			line,
			writerStatus: typeof details.writerStatus === "string" ? details.writerStatus : null,
			frames:
				typeof details.frames === "number" && Number.isFinite(details.frames)
					? Math.round(details.frames)
					: null,
			realFrames:
				typeof details.realFrames === "number" && Number.isFinite(details.realFrames)
					? Math.round(details.realFrames)
					: null,
			holdFrames:
				typeof details.holdFrames === "number" && Number.isFinite(details.holdFrames)
					? Math.round(details.holdFrames)
					: null,
			duration:
				typeof details.duration === "number" && Number.isFinite(details.duration)
					? details.duration
					: null,
			path: typeof details.path === "string" ? details.path : null,
		};
	}

	return null;
}

function getNativeWebcamWriterFinalization(processOutput?: string | null) {
	return getNativeWriterFinalization(processOutput, "WEBCAM_RECORDING_FINALIZED ");
}

function getNativeScreenWriterFinalization(processOutput?: string | null) {
	return getNativeWriterFinalization(processOutput, "VIDEO_RECORDING_FINALIZED ");
}

function getAllowedNativeFrameCountDrift(frameCount: number) {
	return Math.max(
		MIN_NATIVE_FRAME_COUNT_DRIFT,
		Math.round(frameCount * NATIVE_FRAME_COUNT_DRIFT_RATIO),
	);
}

async function recordNativeWebcamSidecarIntegrityEvent({
	event,
	screenPath,
	webcamPath,
	details,
}: {
	event: string;
	screenPath: string;
	webcamPath: string;
	details: Record<string, unknown>;
}) {
	try {
		await appendRecordingEventLogEntry({
			recordingsDir: path.dirname(screenPath),
			sessionId: getRecordingSessionIdForVideoPath(screenPath),
			event,
			details: {
				screenPath,
				webcamPath,
				...details,
			},
		});
	} catch (error) {
		console.warn("Failed to write native webcam integrity event:", error);
	}
}

async function recordNativeScreenIntegrityEvent({
	event,
	screenPath,
	details,
}: {
	event: string;
	screenPath: string;
	details: Record<string, unknown>;
}) {
	try {
		await appendRecordingEventLogEntry({
			recordingsDir: path.dirname(screenPath),
			sessionId: getRecordingSessionIdForVideoPath(screenPath),
			event,
			details: {
				screenPath,
				...details,
			},
		});
	} catch (error) {
		console.warn("Failed to write native screen integrity event:", error);
	}
}

function createNativeScreenIntegrityError(reason: string, line?: string | null) {
	return new Error(
		line
			? `Native screen recording rejected: ${reason} (${line})`
			: `Native screen recording rejected: ${reason}`,
	);
}

function didNativeHelperReachStoppedOutput(processOutput?: string | null) {
	return Boolean(processOutput?.includes("Recording stopped. Output path:"));
}

export async function validateNativeScreenRecordingIntegrity({
	screenPath,
	processOutput,
}: {
	screenPath: string;
	processOutput?: string | null;
}) {
	const persistentFailure = await getPersistentNativeFailureForVideoPath(screenPath);
	if (persistentFailure) {
		await recordNativeScreenIntegrityEvent({
			event: "native-screen-recording-rejected",
			screenPath,
			details: {
				reason: "persistent-native-failure-event",
				persistentEvent: persistentFailure.event,
				persistentDetails: persistentFailure.details,
			},
		});
		throw createNativeScreenIntegrityError(
			"persistent-native-failure-event",
			persistentFailure.line,
		);
	}

	const writerFinalization = getNativeScreenWriterFinalization(processOutput);
	if (!writerFinalization && didNativeHelperReachStoppedOutput(processOutput)) {
		await recordNativeScreenIntegrityEvent({
			event: "native-screen-recording-rejected",
			screenPath,
			details: {
				reason: "writer-finalization-missing-after-stop",
			},
		});
		throw createNativeScreenIntegrityError("writer-finalization-missing-after-stop");
	}

	if (writerFinalization) {
		if (writerFinalization.writerStatus !== "completed") {
			await recordNativeScreenIntegrityEvent({
				event: "native-screen-recording-rejected",
				screenPath,
				details: {
					reason: "writer-finalization-failed",
					writerStatus: writerFinalization.writerStatus,
					writerFrames: writerFinalization.frames,
					writerRealFrames: writerFinalization.realFrames,
					writerHoldFrames: writerFinalization.holdFrames,
					writerDurationSeconds: writerFinalization.duration,
					writerPath: writerFinalization.path,
					writerLine: writerFinalization.line,
				},
			});
			throw createNativeScreenIntegrityError(
				"writer-finalization-failed",
				writerFinalization.line,
			);
		}

		if (writerFinalization.frames !== null && writerFinalization.frames <= 0) {
			await recordNativeScreenIntegrityEvent({
				event: "native-screen-recording-rejected",
				screenPath,
				details: {
					reason: "writer-zero-frames",
					writerStatus: writerFinalization.writerStatus,
					writerFrames: writerFinalization.frames,
					writerRealFrames: writerFinalization.realFrames,
					writerHoldFrames: writerFinalization.holdFrames,
					writerDurationSeconds: writerFinalization.duration,
					writerPath: writerFinalization.path,
					writerLine: writerFinalization.line,
				},
			});
			throw createNativeScreenIntegrityError("writer-zero-frames", writerFinalization.line);
		}

		if (writerFinalization.realFrames !== null && writerFinalization.realFrames <= 0) {
			await recordNativeScreenIntegrityEvent({
				event: "native-screen-recording-rejected",
				screenPath,
				details: {
					reason: "writer-zero-real-frames",
					writerStatus: writerFinalization.writerStatus,
					writerFrames: writerFinalization.frames,
					writerRealFrames: writerFinalization.realFrames,
					writerHoldFrames: writerFinalization.holdFrames,
					writerDurationSeconds: writerFinalization.duration,
					writerPath: writerFinalization.path,
					writerLine: writerFinalization.line,
				},
			});
			throw createNativeScreenIntegrityError(
				"writer-zero-real-frames",
				writerFinalization.line,
			);
		}
	}

	const validation = await validateRecordedVideo(screenPath);
	const screenProbe = await probeVideoStreamDuration(screenPath);
	const writerFinalizedFrameCount = writerFinalization?.frames ?? null;
	const probedFrameCount = getFinitePositiveFrameCount(screenProbe?.frameCount);
	if (writerFinalizedFrameCount !== null && probedFrameCount !== null) {
		const allowedFrameCountDrift = getAllowedNativeFrameCountDrift(writerFinalizedFrameCount);
		const missingFrameCount = writerFinalizedFrameCount - probedFrameCount;
		if (missingFrameCount > allowedFrameCountDrift) {
			await recordNativeScreenIntegrityEvent({
				event: "native-screen-recording-rejected",
				screenPath,
				details: {
					reason: "saved-frame-count-below-writer-summary",
					writerStatus: writerFinalization?.writerStatus ?? null,
					writerFrameCount: writerFinalizedFrameCount,
					writerRealFrames: writerFinalization?.realFrames ?? null,
					writerHoldFrames: writerFinalization?.holdFrames ?? null,
					probedFrameCount,
					missingFrameCount,
					allowedFrameCountDrift,
					durationSeconds: validation.durationSeconds,
					fileSizeBytes: validation.fileSizeBytes,
				},
			});
			throw createNativeScreenIntegrityError(
				"saved-frame-count-below-writer-summary",
				writerFinalization?.line,
			);
		}
	}

	await recordNativeScreenIntegrityEvent({
		event: "native-screen-recording-accepted",
		screenPath,
		details: {
			durationSeconds: validation.durationSeconds,
			fileSizeBytes: validation.fileSizeBytes,
			writerStatus: writerFinalization?.writerStatus ?? null,
			writerFrameCount: writerFinalizedFrameCount,
			writerRealFrames: writerFinalization?.realFrames ?? null,
			writerHoldFrames: writerFinalization?.holdFrames ?? null,
			writerDurationSeconds: writerFinalization?.duration ?? null,
			probedFrameCount,
			probedFrameRate: screenProbe?.frameRate ?? null,
		},
	});

	return validation;
}

export async function resolveValidatedNativeWebcamPath({
	screenPath,
	webcamPath,
	processOutput,
}: {
	screenPath: string;
	webcamPath: string | null | undefined;
	processOutput?: string | null;
}) {
	if (!webcamPath) {
		return null;
	}

	const persistentFailure = await getPersistentNativeFailureForVideoPath(screenPath);
	if (persistentFailure) {
		await recordNativeWebcamSidecarIntegrityEvent({
			event: "native-webcam-sidecar-rejected",
			screenPath,
			webcamPath,
			details: {
				reason: "persistent-native-failure-event",
				persistentEvent: persistentFailure.event,
				persistentDetails: persistentFailure.details,
			},
		});
		console.warn(
			`[native-webcam] Rejected sidecar because event log already contains native failure: ${persistentFailure.event}`,
		);
		return null;
	}

	const failureMarker = getNativeWebcamFailureMarker(processOutput);
	if (failureMarker) {
		await recordNativeWebcamSidecarIntegrityEvent({
			event: "native-webcam-sidecar-rejected",
			screenPath,
			webcamPath,
			details: {
				reason: "native-webcam-failed-closed",
				failureMarker: failureMarker.marker,
				failureLine: failureMarker.line,
			},
		});
		console.warn(
			`[native-webcam] Rejected sidecar because native output reported webcam failure: ${failureMarker.line}`,
		);
		return null;
	}

	const writerFinalization = getNativeWebcamWriterFinalization(processOutput);
	if (writerFinalization) {
		if (writerFinalization.writerStatus !== "completed") {
			await recordNativeWebcamSidecarIntegrityEvent({
				event: "native-webcam-sidecar-rejected",
				screenPath,
				webcamPath,
				details: {
					reason: "writer-finalization-failed",
					writerStatus: writerFinalization.writerStatus,
					writerFrames: writerFinalization.frames,
					writerDurationSeconds: writerFinalization.duration,
					writerPath: writerFinalization.path,
					writerLine: writerFinalization.line,
				},
			});
			console.warn(
				`[native-webcam] Rejected sidecar because writer finalization was not completed: ${writerFinalization.line}`,
			);
			return null;
		}

		if (writerFinalization.frames !== null && writerFinalization.frames <= 0) {
			await recordNativeWebcamSidecarIntegrityEvent({
				event: "native-webcam-sidecar-rejected",
				screenPath,
				webcamPath,
				details: {
					reason: "writer-zero-frames",
					writerStatus: writerFinalization.writerStatus,
					writerFrames: writerFinalization.frames,
					writerDurationSeconds: writerFinalization.duration,
					writerPath: writerFinalization.path,
					writerLine: writerFinalization.line,
				},
			});
			console.warn(
				`[native-webcam] Rejected sidecar because writer finalization reported zero frames: ${writerFinalization.line}`,
			);
			return null;
		}
	}

	const webcamSizeBytes = await getFileSizeIfPresent(webcamPath);
	if (!webcamSizeBytes) {
		await recordNativeWebcamSidecarIntegrityEvent({
			event: "native-webcam-sidecar-missing",
			screenPath,
			webcamPath,
			details: {
				reason: "missing-or-empty",
			},
		});
		return null;
	}

	try {
		const [screenValidation, webcamValidation] = await Promise.all([
			validateRecordedVideo(screenPath),
			validateRecordedVideo(webcamPath),
		]);
		const screenDurationSeconds = screenValidation.durationSeconds;
		const webcamDurationSeconds = webcamValidation.durationSeconds;
		const allowedDriftSeconds =
			getAllowedNativeRecordingDurationDriftSeconds(screenDurationSeconds);
		const driftSeconds = Math.abs(webcamDurationSeconds - screenDurationSeconds);
		const webcamProbe = await probeVideoStreamDuration(webcamPath);
		const webcamEffectiveFps =
			webcamProbe?.frameCount && webcamDurationSeconds > 0
				? webcamProbe.frameCount / webcamDurationSeconds
				: (webcamProbe?.frameRate ?? null);
		const writerFinalizedFrameCount = writerFinalization?.frames ?? null;
		const probedFrameCount = getFinitePositiveFrameCount(webcamProbe?.frameCount);

		if (driftSeconds > allowedDriftSeconds) {
			await recordNativeWebcamSidecarIntegrityEvent({
				event: "native-webcam-sidecar-rejected",
				screenPath,
				webcamPath,
				details: {
					reason: "duration-mismatch",
					screenDurationSeconds,
					webcamDurationSeconds,
					driftSeconds,
					allowedDriftSeconds,
					webcamSizeBytes: webcamValidation.fileSizeBytes,
				},
			});
			console.warn(
				`[native-webcam] Rejected sidecar duration mismatch: screen=${screenDurationSeconds.toFixed(2)}s webcam=${webcamDurationSeconds.toFixed(2)}s drift=${driftSeconds.toFixed(2)}s allowed=${allowedDriftSeconds.toFixed(2)}s`,
			);
			return null;
		}

		if (writerFinalizedFrameCount !== null && probedFrameCount !== null) {
			const allowedFrameCountDrift =
				getAllowedNativeFrameCountDrift(writerFinalizedFrameCount);
			const missingFrameCount = writerFinalizedFrameCount - probedFrameCount;
			if (missingFrameCount > allowedFrameCountDrift) {
				await recordNativeWebcamSidecarIntegrityEvent({
					event: "native-webcam-sidecar-rejected",
					screenPath,
					webcamPath,
					details: {
						reason: "saved-frame-count-below-writer-summary",
						writerStatus: writerFinalization?.writerStatus ?? null,
						writerFrameCount: writerFinalizedFrameCount,
						probedFrameCount,
						missingFrameCount,
						allowedFrameCountDrift,
						screenDurationSeconds,
						webcamDurationSeconds,
						webcamSizeBytes: webcamValidation.fileSizeBytes,
					},
				});
				console.warn(
					`[native-webcam] Rejected sidecar frame-count mismatch: writer=${writerFinalizedFrameCount} probed=${probedFrameCount} missing=${missingFrameCount} allowed=${allowedFrameCountDrift}`,
				);
				return null;
			}
		}

		if (
			webcamEffectiveFps !== null &&
			Number.isFinite(webcamEffectiveFps) &&
			webcamEffectiveFps < MIN_ACCEPTABLE_WEBCAM_EFFECTIVE_FPS
		) {
			await recordNativeWebcamSidecarIntegrityEvent({
				event: "native-webcam-sidecar-rejected",
				screenPath,
				webcamPath,
				details: {
					reason: "low-frame-cadence",
					screenDurationSeconds,
					webcamDurationSeconds,
					webcamEffectiveFps,
					minAcceptableFps: MIN_ACCEPTABLE_WEBCAM_EFFECTIVE_FPS,
					webcamFrameCount: webcamProbe?.frameCount ?? null,
					webcamFrameRate: webcamProbe?.frameRate ?? null,
					webcamSizeBytes: webcamValidation.fileSizeBytes,
				},
			});
			console.warn(
				`[native-webcam] Rejected sidecar low frame cadence: duration=${webcamDurationSeconds.toFixed(2)}s effectiveFps=${webcamEffectiveFps.toFixed(2)} min=${MIN_ACCEPTABLE_WEBCAM_EFFECTIVE_FPS}`,
			);
			return null;
		}

		await recordNativeWebcamSidecarIntegrityEvent({
			event: "native-webcam-sidecar-accepted",
			screenPath,
			webcamPath,
			details: {
				screenDurationSeconds,
				webcamDurationSeconds,
				driftSeconds,
				allowedDriftSeconds,
				webcamSizeBytes: webcamValidation.fileSizeBytes,
				webcamEffectiveFps,
				webcamFrameCount: webcamProbe?.frameCount ?? null,
				webcamFrameRate: webcamProbe?.frameRate ?? null,
				writerStatus: writerFinalization?.writerStatus ?? null,
				writerFrameCount: writerFinalizedFrameCount,
				writerDurationSeconds: writerFinalization?.duration ?? null,
			},
		});
		return webcamPath;
	} catch (error) {
		await recordNativeWebcamSidecarIntegrityEvent({
			event: "native-webcam-sidecar-rejected",
			screenPath,
			webcamPath,
			details: {
				reason: "validation-failed",
				error: error instanceof Error ? error.message : String(error),
				webcamSizeBytes,
			},
		});
		console.warn("Rejected native webcam sidecar after validation failure:", error);
		return null;
	}
}

export async function recordNativeScreenDurationIntegrityEvent({
	screenPath,
	expectedDurationMs,
}: {
	screenPath: string;
	expectedDurationMs: number | null;
}) {
	if (expectedDurationMs === null || expectedDurationMs <= 0) {
		return;
	}

	try {
		const validation = await validateRecordedVideo(screenPath);
		const expectedDurationSeconds = expectedDurationMs / 1000;
		const actualDurationSeconds = validation.durationSeconds;
		const allowedDriftSeconds =
			getAllowedNativeRecordingDurationDriftSeconds(expectedDurationSeconds);
		const shortfallSeconds = expectedDurationSeconds - actualDurationSeconds;
		const overrunSeconds = actualDurationSeconds - expectedDurationSeconds;

		if (shortfallSeconds > allowedDriftSeconds) {
			await appendRecordingEventLogEntry({
				recordingsDir: path.dirname(screenPath),
				sessionId: getRecordingSessionIdForVideoPath(screenPath),
				event: "native-screen-duration-short",
				details: {
					screenPath,
					expectedDurationSeconds,
					actualDurationSeconds,
					shortfallSeconds,
					allowedDriftSeconds,
					fileSizeBytes: validation.fileSizeBytes,
				},
			});
			console.warn(
				`[native-screen] Output is shorter than expected: expected=${expectedDurationSeconds.toFixed(2)}s actual=${actualDurationSeconds.toFixed(2)}s shortfall=${shortfallSeconds.toFixed(2)}s allowed=${allowedDriftSeconds.toFixed(2)}s`,
			);
			return;
		}

		if (overrunSeconds > allowedDriftSeconds) {
			await appendRecordingEventLogEntry({
				recordingsDir: path.dirname(screenPath),
				sessionId: getRecordingSessionIdForVideoPath(screenPath),
				event: "native-screen-duration-long",
				details: {
					screenPath,
					expectedDurationSeconds,
					actualDurationSeconds,
					overrunSeconds,
					allowedDriftSeconds,
					fileSizeBytes: validation.fileSizeBytes,
				},
			});
		}
	} catch (error) {
		try {
			await appendRecordingEventLogEntry({
				recordingsDir: path.dirname(screenPath),
				sessionId: getRecordingSessionIdForVideoPath(screenPath),
				event: "native-screen-duration-validation-failed",
				details: {
					screenPath,
					expectedDurationMs,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		} catch (logError) {
			console.warn("Failed to write native screen duration validation event:", logError);
		}
	}
}

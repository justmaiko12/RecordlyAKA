import fs from "node:fs/promises";
import path from "node:path";
import {
	getRecordingSourceAudioSyncPlan,
	probeRecordingAudioDurationSeconds,
	probeRecordingSourceAudioVideoDurations,
	RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS,
	type RecordingSourceAudioVideoDurations,
} from "./sourceAudioSync";

const MAX_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS = 1;
const MIN_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS = 0.75;
const NATIVE_WEBCAM_DURATION_DRIFT_RATIO = 0.001;
const MAX_ACCEPTED_PROOF_TAIL_DRIFT_SECONDS = 15;
const MAX_ACCEPTED_PROOF_TAIL_FRAME_DRIFT = 90;
const MAX_ACCEPTED_PROOF_HEAD_DRIFT_SECONDS = 15;
const MAX_ACCEPTED_PROOF_HEAD_FRAME_DRIFT = 90;
const MAX_PREVIEW_HANDOFF_REPROOF_SECONDS = 3;
const MIN_ACCEPTED_PROOF_SAMPLE_COUNT = 3;
const MAX_SECONDS_PER_ACCEPTED_PROOF_SAMPLE = 3;
const MAX_ACCEPTED_PROOF_GAP_SECONDS = 3.5;
const MIN_BROWSER_MIC_CHUNK_TIMING_EVENTS = 3;
const MAX_SECONDS_PER_BROWSER_MIC_CHUNK_TIMING_EVENT = 10;

const FAILURE_EVENTS = new Set([
	"native-helper-exited-unexpectedly",
	"native-recording-degraded",
	"native-video-capture-stats-stale",
	"native-video-stream-stopped-with-error",
	"native-video-pipeline-stalled",
	"native-audio-capture-stats-stale",
	"native-audio-pipeline-stalled",
	"native-microphone-recording-finalized-unhealthy",
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
	"native-screen-duration-long",
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

const WEBCAM_EVIDENCE_EVENTS = new Set([
	"native-webcam-capture-started",
	"native-webcam-first-frame-written",
	"native-webcam-first-visible-frame-written",
	"native-webcam-capture-stats",
	"native-webcam-capture-low-cadence",
	"native-webcam-preview-frame-written",
	"native-webcam-visual-freeze-review",
	"native-webcam-hold-frames-inserted",
	"native-webcam-proof-preview-accepted",
	"native-webcam-sidecar-accepted",
	"native-webcam-sidecar-rejected",
	"native-webcam-sidecar-missing",
	"native-webcam-recording-finalized",
]);

export type RecordingRunAuditStatus = "pass" | "warning" | "fail";

export type RecordingRunAuditIssue = {
	code: string;
	message: string;
	details?: Record<string, unknown>;
};

export type RecordingRunAuditPaths = {
	inputPath: string;
	videoPath: string;
	eventLogPath: string;
	diagnosticsPath: string;
};

export type RecordingRunAuditSummary = {
	eventCount?: number;
	eventCounts?: Record<string, number>;
	sawWebcamEvidence?: boolean;
	sourceMediaDurations?: {
		videoDurationSeconds: number | null;
		audioDurationSeconds: number | null;
		driftSeconds: number | null;
		planAction: string;
		planReason: string;
		tempoRatio: number;
		toleranceSeconds: number;
		preferredAudioSource?: "embedded" | "mic-companion";
		preferredAudioPaths?: string[];
	} | null;
	companionAudioDurations?: Array<{
		trackKind: "mic";
		audioPath: string;
		videoDurationSeconds: number | null;
		audioDurationSeconds: number | null;
		driftSeconds: number | null;
		planAction: string;
		planReason: string;
		tempoRatio: number;
		toleranceSeconds: number;
	}>;
	proof?: {
		count: number;
		rejectedCount: number;
		monotonic: boolean;
		maxAcceptedPtsGapSeconds: number;
		maxAcceptedFrameGap: number;
		largeGapCount: number;
		largeGaps: Array<Record<string, unknown>>;
		first: Record<string, unknown> | null;
		last: Record<string, unknown> | null;
	};
	previewHandoff?: {
		present: boolean;
		acceptedProofCount: number | null;
		lastAcceptedProof: Record<string, unknown> | null;
		hasVisibleWebcamFrame: boolean | null;
		requestedDeviceId: string | null;
		requestedLabel: string | null;
		captureLabel: string | null;
		firstVisibleFrame: Record<string, unknown> | null;
	};
	recordingWebcamIdentity?: {
		selectedDeviceId: string | null;
		resolvedDeviceId: string | null;
		resolvedLabel: string | null;
		captureLabel: string | null;
	};
	rendererPreviewIssues?: {
		count: number;
		first: Record<string, unknown> | null;
		last: Record<string, unknown> | null;
	};
	webcamCadence?: WebcamCadenceSummary;
	webcamVisualFreezeReviews?: ReviewSegmentSummary;
	audioContinuityRepairs?: ContinuityRepairSummary;
	webcamContinuityRepairs?: ContinuityRepairSummary;
	nativeMicrophone?: {
		requested: boolean;
		firstBufferWritten: boolean;
		unavailable: boolean;
		deviceEvent: Record<string, unknown> | null;
		firstBuffer: Record<string, unknown> | null;
	};
	microphoneChunkTiming?: Array<Record<string, unknown>>;
	screenFinalization?: WriterFinalizationSummary | null;
	webcamFinalization?: WriterFinalizationSummary | null;
	diagnosticsLatestPhase?: unknown;
	diagnosticsExpectedDurationMs?: unknown;
};

type ContinuityRepairSummary = {
	count: number;
	totalFrames?: number;
	totalBuffers?: number;
	totalDurationSeconds: number;
	firstTargetPtsSeconds?: number;
	lastTargetPtsSeconds?: number;
	first: Record<string, unknown> | null;
	last: Record<string, unknown> | null;
};

type ReviewSegmentSummary = {
	count: number;
	totalDurationSeconds: number;
	firstStartPtsSeconds?: number;
	firstEndPtsSeconds?: number;
	lastStartPtsSeconds?: number;
	lastEndPtsSeconds?: number;
	first: Record<string, unknown> | null;
	last: Record<string, unknown> | null;
};

type WebcamCadenceSummary = {
	statsCount: number;
	targetFps: number | null;
	maxRecentFps: number | null;
	maxTotalFps: number | null;
	finalizationFps: number | null;
	throttledFrames: number;
	first: Record<string, unknown> | null;
	last: Record<string, unknown> | null;
	finalization: Record<string, unknown> | null;
};

const WEBCAM_CADENCE_WARNING_MULTIPLIER = 1.2;
const WEBCAM_CADENCE_FAILURE_MULTIPLIER = 1.5;

export type RecordingRunAuditResult = {
	status: RecordingRunAuditStatus;
	paths: RecordingRunAuditPaths;
	issues: RecordingRunAuditIssue[];
	warnings: RecordingRunAuditIssue[];
	summary: RecordingRunAuditSummary;
};

export type RecordingRunAuditOptions = {
	probeSourceMediaDurations?: (
		videoPath: string,
	) => Promise<RecordingSourceAudioVideoDurations | null>;
	probeCompanionAudioDurationSeconds?: (audioPath: string) => Promise<number | null>;
};

type EventLogEntry = {
	timestamp?: unknown;
	event: string;
	details?: unknown;
};

type WriterFinalizationSummary = {
	writerStatus: string | null;
	frames: number | null;
	realFrames: number | null;
	holdFrames: number | null;
	duration: number | null;
	lastPts: number | null;
	path: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getString(value: unknown) {
	return typeof value === "string" ? value : null;
}

function getNonEmptyString(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCameraIdentity(value: string) {
	return value
		.normalize("NFKC")
		.replace(/[’‘]/g, "'")
		.replace(/\s+\(native\)\s*$/iu, "")
		.replace(/\s+\([^)]*\)\s*$/u, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function sameCameraIdentity(left: string, right: string) {
	return normalizeCameraIdentity(left) === normalizeCameraIdentity(right);
}

function getAllowedDurationDriftSeconds(durationSeconds: number) {
	return Math.min(
		MAX_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS,
		Math.max(
			MIN_NATIVE_WEBCAM_DURATION_DRIFT_SECONDS,
			durationSeconds * NATIVE_WEBCAM_DURATION_DRIFT_RATIO,
		),
	);
}

export function assertRecordingRunAuditPassed(
	audit: RecordingRunAuditResult,
	videoPath = audit.paths.videoPath,
) {
	if (audit.status !== "fail") {
		return;
	}

	const primaryIssue = audit.issues[0];
	const primaryMessage = primaryIssue?.message ?? "Recording failed the native integrity audit.";
	throw new Error(
		[
			`Recording failed native integrity audit: ${primaryMessage}`,
			videoPath ? `Saved file: ${videoPath}` : null,
			audit.paths.eventLogPath ? `Event log: ${audit.paths.eventLogPath}` : null,
		]
			.filter(Boolean)
			.join(" "),
	);
}

function getArtifactsForInput(inputPath: string): RecordingRunAuditPaths {
	const absoluteInput = path.resolve(inputPath);
	const ext = path.extname(absoluteInput).toLowerCase();
	if (ext === ".jsonl") {
		const eventLogPath = absoluteInput;
		const videoPath = absoluteInput.replace(/\.recordly-events\.jsonl$/u, ".mp4");
		return {
			inputPath: absoluteInput,
			videoPath,
			eventLogPath,
			diagnosticsPath: videoPath.replace(/\.[^.]+$/u, ".recording-diagnostics.json"),
		};
	}

	return {
		inputPath: absoluteInput,
		videoPath: absoluteInput,
		eventLogPath: absoluteInput.replace(/\.[^.]+$/u, ".recordly-events.jsonl"),
		diagnosticsPath: absoluteInput.replace(/\.[^.]+$/u, ".recording-diagnostics.json"),
	};
}

async function readJsonIfPresent(filePath: string) {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
	} catch {
		return null;
	}
}

async function readEventLog(filePath: string) {
	const raw = await fs.readFile(filePath, "utf8");
	const entries: EventLogEntry[] = [];
	const parseErrors: Array<{ line: number; error: string }> = [];
	for (const [index, line] of raw.split(/\r?\n/u).entries()) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isRecord(parsed) && typeof parsed.event === "string") {
				entries.push(parsed as EventLogEntry);
			}
		} catch (error) {
			parseErrors.push({
				line: index + 1,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { entries, parseErrors };
}

function getDetails(entry: EventLogEntry | null | undefined): Record<string, unknown> {
	return isRecord(entry?.details) ? entry.details : {};
}

function findLast(entries: EventLogEntry[], eventName: string) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.event === eventName) {
			return entries[index];
		}
	}
	return null;
}

function findFirst(entries: EventLogEntry[], eventName: string) {
	return entries.find((entry) => entry.event === eventName) ?? null;
}

function countByEvent(entries: EventLogEntry[]) {
	const counts: Record<string, number> = {};
	for (const entry of entries) {
		counts[entry.event] = (counts[entry.event] ?? 0) + 1;
	}
	return counts;
}

function getFinalizationSummary(entry: EventLogEntry | null): WriterFinalizationSummary | null {
	if (!entry) {
		return null;
	}
	const details = getDetails(entry);
	return {
		writerStatus: getString(details.writerStatus),
		frames: getNumber(details.frames),
		realFrames: getNumber(details.realFrames),
		holdFrames: getNumber(details.holdFrames),
		duration: getNumber(details.duration),
		lastPts: getNumber(details.lastPts),
		path: getString(details.path),
	};
}

function getProofSummary(entries: EventLogEntry[]) {
	const proofEntries = entries.filter(
		(entry) => entry.event === "native-webcam-proof-preview-accepted",
	);
	const rejectedEntries = entries.filter(
		(entry) => entry.event === "native-webcam-preview-frame-rejected",
	);
	let monotonic = true;
	let previous: {
		sequence: number | null;
		acceptedFrame: number | null;
		acceptedPts: number | null;
	} | null = null;
	let maxAcceptedPtsGapSeconds = 0;
	let maxAcceptedFrameGap = 0;
	const largeGaps: Array<Record<string, unknown>> = [];

	for (const entry of proofEntries) {
		const details = getDetails(entry);
		const current = {
			sequence: getNumber(details.sequence),
			acceptedFrame: getNumber(details.acceptedFrame),
			acceptedPts: getNumber(details.acceptedPts),
		};
		if (
			previous &&
			current.sequence !== null &&
			previous.sequence !== null &&
			current.sequence <= previous.sequence
		) {
			monotonic = false;
		}
		if (
			previous &&
			current.acceptedFrame !== null &&
			previous.acceptedFrame !== null &&
			current.acceptedFrame <= previous.acceptedFrame
		) {
			monotonic = false;
		}
		if (
			previous &&
			current.acceptedPts !== null &&
			previous.acceptedPts !== null &&
			current.acceptedPts < previous.acceptedPts
		) {
			monotonic = false;
		}
		if (previous) {
			if (current.acceptedPts !== null && previous.acceptedPts !== null) {
				const acceptedPtsGapSeconds = current.acceptedPts - previous.acceptedPts;
				maxAcceptedPtsGapSeconds = Math.max(maxAcceptedPtsGapSeconds, acceptedPtsGapSeconds);
				if (acceptedPtsGapSeconds > MAX_ACCEPTED_PROOF_GAP_SECONDS) {
					largeGaps.push({
						index: largeGaps.length,
						acceptedPtsGapSeconds,
						previousAcceptedPts: previous.acceptedPts,
						currentAcceptedPts: current.acceptedPts,
						previousAcceptedFrame: previous.acceptedFrame,
						currentAcceptedFrame: current.acceptedFrame,
						previousSequence: previous.sequence,
						currentSequence: current.sequence,
					});
				}
			}
			if (current.acceptedFrame !== null && previous.acceptedFrame !== null) {
				maxAcceptedFrameGap = Math.max(
					maxAcceptedFrameGap,
					current.acceptedFrame - previous.acceptedFrame,
				);
			}
		}
		previous = current;
	}

	return {
		count: proofEntries.length,
		rejectedCount: rejectedEntries.length,
		monotonic,
		maxAcceptedPtsGapSeconds: Math.round(maxAcceptedPtsGapSeconds * 1000) / 1000,
		maxAcceptedFrameGap,
		largeGapCount: largeGaps.length,
		largeGaps: largeGaps.slice(0, 10),
		first: proofEntries[0] ? getDetails(proofEntries[0]) : null,
		last: proofEntries.length > 0 ? getDetails(proofEntries[proofEntries.length - 1]) : null,
	};
}

function getRendererPreviewIssueSummary(entries: EventLogEntry[]) {
	const issueEntries = entries.filter(
		(entry) => entry.event === "native-webcam-preview-renderer-issue",
	);

	return {
		count: issueEntries.length,
		first: issueEntries[0] ? getDetails(issueEntries[0]) : null,
		last: issueEntries.length > 0 ? getDetails(issueEntries[issueEntries.length - 1]) : null,
	};
}

function getContinuityRepairSummary(
	entries: EventLogEntry[],
	eventName: string,
): ContinuityRepairSummary {
	const issueEntries = entries.filter((entry) => entry.event === eventName);
	let totalFrames = 0;
	let totalBuffers = 0;
	let totalDurationSeconds = 0;

	for (const entry of issueEntries) {
		const details = getDetails(entry);
		totalFrames += getNumber(details.frames) ?? 0;
		totalBuffers += getNumber(details.buffers) ?? 0;
		totalDurationSeconds += getNumber(details.duration) ?? 0;
	}

	return {
		count: issueEntries.length,
		...(totalFrames > 0 ? { totalFrames } : {}),
		...(totalBuffers > 0 ? { totalBuffers } : {}),
		totalDurationSeconds: Math.round(totalDurationSeconds * 1000) / 1000,
		...(issueEntries[0] && getNumber(getDetails(issueEntries[0]).targetPts) !== null
			? { firstTargetPtsSeconds: getNumber(getDetails(issueEntries[0]).targetPts)! }
			: {}),
		...(issueEntries.length > 0 &&
		getNumber(getDetails(issueEntries[issueEntries.length - 1]).targetPts) !== null
			? {
					lastTargetPtsSeconds: getNumber(
						getDetails(issueEntries[issueEntries.length - 1]).targetPts,
					)!,
				}
			: {}),
		first: issueEntries[0] ? getDetails(issueEntries[0]) : null,
		last: issueEntries.length > 0 ? getDetails(issueEntries[issueEntries.length - 1]) : null,
	};
}

function getReviewSegmentSummary(
	entries: EventLogEntry[],
	eventName: string,
): ReviewSegmentSummary {
	const issueEntries = entries.filter((entry) => entry.event === eventName);
	let totalDurationSeconds = 0;

	for (const entry of issueEntries) {
		const details = getDetails(entry);
		totalDurationSeconds += getNumber(details.stalledFor) ?? 0;
	}

	const first = issueEntries[0] ? getDetails(issueEntries[0]) : null;
	const last = issueEntries.length > 0 ? getDetails(issueEntries[issueEntries.length - 1]) : null;
	return {
		count: issueEntries.length,
		totalDurationSeconds: Math.round(totalDurationSeconds * 1000) / 1000,
		...(getNumber(first?.startPts) !== null
			? { firstStartPtsSeconds: getNumber(first?.startPts)! }
			: {}),
		...(getNumber(first?.endPts) !== null
			? { firstEndPtsSeconds: getNumber(first?.endPts)! }
			: {}),
		...(getNumber(last?.startPts) !== null
			? { lastStartPtsSeconds: getNumber(last?.startPts)! }
			: {}),
		...(getNumber(last?.endPts) !== null ? { lastEndPtsSeconds: getNumber(last?.endPts)! } : {}),
		first,
		last,
	};
}

function getWebcamCadenceSummary(entries: EventLogEntry[]): WebcamCadenceSummary {
	const statsEntries = entries.filter((entry) => entry.event === "native-webcam-capture-stats");
	const first = statsEntries[0] ? getDetails(statsEntries[0]) : null;
	const last = statsEntries.length > 0 ? getDetails(statsEntries[statsEntries.length - 1]) : null;
	const settings = getDetails(findLast(entries, "native-webcam-capture-settings-resolved"));
	const finalization = getDetails(findLast(entries, "native-webcam-recording-finalized"));
	const targetFps =
		getNumber(last?.targetFps) ??
		getNumber(first?.targetFps) ??
		getNumber(settings.effectiveFrameRate) ??
		getNumber(settings.requestedFrameRate);
	let maxRecentFps: number | null = null;
	let maxTotalFps: number | null = null;
	let throttledFrames = 0;

	for (const entry of statsEntries) {
		const details = getDetails(entry);
		const recentFps = getNumber(details.recentFps);
		const totalFps = getNumber(details.totalFps);
		maxRecentFps =
			recentFps === null ? maxRecentFps : Math.max(maxRecentFps ?? recentFps, recentFps);
		maxTotalFps =
			totalFps === null ? maxTotalFps : Math.max(maxTotalFps ?? totalFps, totalFps);
		throttledFrames = Math.max(throttledFrames, getNumber(details.throttledFrames) ?? 0);
	}

	const finalizationFrames = getNumber(finalization.frames);
	const finalizationDuration = getNumber(finalization.duration);
	const finalizationFps =
		finalizationFrames !== null && finalizationDuration !== null && finalizationDuration > 0
			? finalizationFrames / finalizationDuration
			: null;
	if (finalizationFps !== null) {
		maxTotalFps = Math.max(maxTotalFps ?? finalizationFps, finalizationFps);
	}

	return {
		statsCount: statsEntries.length,
		targetFps: targetFps ?? null,
		maxRecentFps,
		maxTotalFps,
		finalizationFps,
		throttledFrames,
		first,
		last,
		finalization: Object.keys(finalization).length > 0 ? finalization : null,
	};
}

function webcamCadenceExceededTarget(cadence: WebcamCadenceSummary) {
	if (
		cadence.targetFps === null ||
		cadence.targetFps <= 0 ||
		cadence.maxTotalFps === null
	) {
		return false;
	}

	return cadence.maxTotalFps > cadence.targetFps * WEBCAM_CADENCE_WARNING_MULTIPLIER;
}

function webcamCadenceSeverelyExceededTarget(cadence: WebcamCadenceSummary) {
	if (
		cadence.targetFps === null ||
		cadence.targetFps <= 0 ||
		cadence.maxTotalFps === null
	) {
		return false;
	}

	return cadence.maxTotalFps > cadence.targetFps * WEBCAM_CADENCE_FAILURE_MULTIPLIER;
}

function pushIssue(
	issues: RecordingRunAuditIssue[],
	code: string,
	message: string,
	details: Record<string, unknown> = {},
) {
	issues.push({ code, message, details });
}

function summarizeSourceMediaDurations(
	durations: RecordingSourceAudioVideoDurations,
	preferredAudio?: {
		source: "embedded" | "mic-companion";
		paths: string[];
	},
) {
	const plan = getRecordingSourceAudioSyncPlan(durations);
	return {
		videoDurationSeconds: plan.videoDurationSeconds,
		audioDurationSeconds: plan.audioDurationSeconds,
		driftSeconds: plan.driftSeconds,
		planAction: plan.action,
		planReason: plan.reason,
		tempoRatio: plan.tempoRatio,
		toleranceSeconds: RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS,
		...(preferredAudio
			? {
					preferredAudioSource: preferredAudio.source,
					preferredAudioPaths: preferredAudio.paths,
				}
			: {}),
	};
}

function summarizeCompanionAudioDurations({
	audioPath,
	trackKind,
	videoDurationSeconds,
	audioDurationSeconds,
}: {
	audioPath: string;
	trackKind: "mic";
	videoDurationSeconds: number | null;
	audioDurationSeconds: number | null;
}) {
	const plan = getRecordingSourceAudioSyncPlan({
		videoDurationSeconds,
		audioDurationSeconds,
	});
	return {
		audioPath,
		trackKind,
		videoDurationSeconds: plan.videoDurationSeconds,
		audioDurationSeconds: plan.audioDurationSeconds,
		driftSeconds: plan.driftSeconds,
		planAction: plan.action,
		planReason: plan.reason,
		tempoRatio: plan.tempoRatio,
		toleranceSeconds: RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS,
	};
}

function getMicrophoneChunkTimingDiagnostics(diagnostics: unknown): Record<string, unknown>[] {
	if (!isRecord(diagnostics) || !Array.isArray(diagnostics.events)) {
		return [];
	}

	const summaries: Record<string, unknown>[] = [];
	for (const event of diagnostics.events) {
		if (!isRecord(event) || event.phase !== "mic-sidecar") {
			continue;
		}
		const details = isRecord(event.details) ? event.details : null;
		const metadata = isRecord(details?.metadata) ? details.metadata : null;
		const chunkTiming = isRecord(metadata?.chunkTiming) ? metadata.chunkTiming : null;
		if (!chunkTiming) {
			continue;
		}
		summaries.push({
			timestamp: event.timestamp ?? null,
			phase: event.phase,
			...chunkTiming,
		});
	}
	return summaries;
}

async function getPreferredSourceAudioForAudit(videoPath: string) {
	const basePath = videoPath.replace(/\.[^.]+$/u, "");
	const candidatePaths = [`${basePath}.mic.m4a`, `${basePath}.mic.webm`, `${basePath}.mic.wav`];
	const micCompanionPaths: string[] = [];

	for (const candidatePath of candidatePaths) {
		try {
			const stat = await fs.stat(candidatePath);
			if (stat.size > 0) {
				micCompanionPaths.push(candidatePath);
			}
		} catch {
			// Missing companion audio is expected for screen-only or system-audio-only recordings.
		}
	}

	if (micCompanionPaths.length > 0) {
		return {
			source: "mic-companion" as const,
			paths: micCompanionPaths,
		};
	}

	return {
		source: "embedded" as const,
		paths: [videoPath],
	};
}

function getMinimumAcceptedProofCount(durationSeconds: number) {
	return Math.max(
		MIN_ACCEPTED_PROOF_SAMPLE_COUNT,
		Math.floor(durationSeconds / MAX_SECONDS_PER_ACCEPTED_PROOF_SAMPLE),
	);
}

function getMinimumBrowserMicChunkTimingEventCount(durationSeconds: number | null) {
	if (!Number.isFinite(durationSeconds) || durationSeconds === null || durationSeconds <= 0) {
		return MIN_BROWSER_MIC_CHUNK_TIMING_EVENTS;
	}

	const minimumForDuration = Math.floor(
		durationSeconds / MAX_SECONDS_PER_BROWSER_MIC_CHUNK_TIMING_EVENT,
	);
	return Math.max(
		durationSeconds < MAX_SECONDS_PER_BROWSER_MIC_CHUNK_TIMING_EVENT
			? 1
			: MIN_BROWSER_MIC_CHUNK_TIMING_EVENTS,
		minimumForDuration,
	);
}

function getUnsafeCompanionAudioRepair(details: Record<string, unknown>) {
	const videoDurationSeconds = getNumber(details.videoDurationSeconds);
	const audioDurationSeconds = getNumber(details.audioDurationSeconds);
	const safetyPlan = getRecordingSourceAudioSyncPlan({
		videoDurationSeconds,
		audioDurationSeconds,
	});

	if (safetyPlan.action !== "reject") {
		return null;
	}

	return {
		...details,
		currentSafetyPlan: safetyPlan,
	};
}

function hasBrowserMicrophoneCompanionSidecar(
	preferredAudio: Awaited<ReturnType<typeof getPreferredSourceAudioForAudit>>,
) {
	return (
		preferredAudio.source === "mic-companion" &&
		preferredAudio.paths.some((candidatePath) => candidatePath.endsWith(".mic.wav"))
	);
}

export async function auditRecordingRun(
	inputPath: string,
	options: RecordingRunAuditOptions = {},
): Promise<RecordingRunAuditResult> {
	const artifacts = getArtifactsForInput(inputPath);
	const issues: RecordingRunAuditIssue[] = [];
	const warnings: RecordingRunAuditIssue[] = [];
	let eventLog: Awaited<ReturnType<typeof readEventLog>>;
	try {
		eventLog = await readEventLog(artifacts.eventLogPath);
	} catch (error) {
		return {
			status: "fail",
			paths: artifacts,
			issues: [
				{
					code: "missing-event-log",
					message: `Recording event log is missing or unreadable: ${artifacts.eventLogPath}`,
					details: {
						error: error instanceof Error ? error.message : String(error),
					},
				},
			],
			warnings: [],
			summary: {},
		};
	}

	const diagnostics = await readJsonIfPresent(artifacts.diagnosticsPath);
	const microphoneChunkTiming = getMicrophoneChunkTimingDiagnostics(diagnostics);
	const entries = eventLog.entries;
	const eventCounts = countByEvent(entries);
	const sawWebcamEvidence = entries.some((entry) => WEBCAM_EVIDENCE_EVENTS.has(entry.event));
	const proof = getProofSummary(entries);
	const rendererPreviewIssues = getRendererPreviewIssueSummary(entries);
	const webcamCadence = getWebcamCadenceSummary(entries);
	const webcamVisualFreezeReviews = getReviewSegmentSummary(
		entries,
		"native-webcam-visual-freeze-review",
	);
	const audioContinuityRepairs = getContinuityRepairSummary(
		entries,
		"native-audio-silence-inserted",
	);
	const webcamContinuityRepairs = getContinuityRepairSummary(
		entries,
		"native-webcam-hold-frames-inserted",
	);
	const previewHandoff = findLast(entries, "native-webcam-preview-handoff");
	const recordingWebcamSelection = findLast(entries, "native-webcam-selection-resolved");
	const recordingWebcamCaptureStarted = findFirst(entries, "native-webcam-capture-started");
	const firstVisibleWebcamFrame = findFirst(entries, "native-webcam-first-visible-frame-written");
	const nativeMicrophoneDevice =
		findLast(entries, "native-microphone-device-resolved") ??
		findLast(entries, "native-microphone-device-default");
	const nativeMicrophoneFirstBuffer = findFirst(
		entries,
		"native-microphone-audio-first-buffer-written",
	);
	const nativeMicrophoneUnavailable = findFirst(entries, "native-microphone-capture-unavailable");
	const nativeMicrophoneRequested = nativeMicrophoneDevice !== null;
	const screenFinalization = getFinalizationSummary(
		findLast(entries, "native-video-recording-finalized"),
	);
	const webcamFinalization = getFinalizationSummary(
		findLast(entries, "native-webcam-recording-finalized"),
	);
	let sourceMediaDurations: RecordingRunAuditSummary["sourceMediaDurations"] = null;
	let preferredAudioForAudit: Awaited<ReturnType<typeof getPreferredSourceAudioForAudit>> | null =
		null;
	const companionAudioDurations: NonNullable<
		RecordingRunAuditSummary["companionAudioDurations"]
	> = [];

	try {
		const preferredAudio = await getPreferredSourceAudioForAudit(artifacts.videoPath);
		preferredAudioForAudit = preferredAudio;
		const probeSourceMediaDurations =
			options.probeSourceMediaDurations ?? probeRecordingSourceAudioVideoDurations;
		const probedDurations = await probeSourceMediaDurations(artifacts.videoPath);
		if (probedDurations) {
			sourceMediaDurations = summarizeSourceMediaDurations(probedDurations, preferredAudio);
			if (
				preferredAudio.source === "embedded" &&
				(sourceMediaDurations.planAction === "repair" ||
					sourceMediaDurations.planAction === "reject")
			) {
				pushIssue(
					issues,
					"source-media-audio-duration-drift",
					"Finalized source media still has embedded audio/video duration drift after recording finalization.",
					sourceMediaDurations,
				);
			} else if (
				sourceMediaDurations.planReason === "invalid-duration" &&
				(preferredAudio.source === "embedded" ||
					sourceMediaDurations.videoDurationSeconds === null ||
					!Number.isFinite(sourceMediaDurations.videoDurationSeconds) ||
					sourceMediaDurations.videoDurationSeconds <= 0)
			) {
				pushIssue(
					issues,
					"source-media-duration-invalid",
					"Finalized source media has invalid video or audio duration metadata.",
					sourceMediaDurations,
				);
			}

			if (preferredAudio.source === "mic-companion") {
				const probeCompanionAudioDurationSeconds =
					options.probeCompanionAudioDurationSeconds ??
					probeRecordingAudioDurationSeconds;
				for (const audioPath of preferredAudio.paths) {
					try {
						const companionSummary = summarizeCompanionAudioDurations({
							audioPath,
							trackKind: "mic",
							videoDurationSeconds: sourceMediaDurations.videoDurationSeconds,
							audioDurationSeconds:
								await probeCompanionAudioDurationSeconds(audioPath),
						});
						companionAudioDurations.push(companionSummary);
						if (
							companionSummary.planReason === "missing-audio" ||
							companionSummary.planReason === "invalid-duration"
						) {
							pushIssue(
								issues,
								"companion-mic-audio-duration-invalid",
								"Preferred companion mic audio is missing or has invalid duration.",
								companionSummary,
							);
						} else if (companionSummary.planAction !== "none") {
							pushIssue(
								issues,
								"companion-mic-audio-duration-drift",
								"Preferred companion mic audio still has duration drift after recording finalization.",
								companionSummary,
							);
						}
					} catch (error) {
						pushIssue(
							issues,
							"companion-mic-audio-duration-probe-failed",
							"Failed to probe preferred companion mic audio duration.",
							{
								audioPath,
								error: error instanceof Error ? error.message : String(error),
							},
						);
					}
				}
			}
		}
	} catch (error) {
		pushIssue(
			issues,
			"source-media-duration-probe-failed",
			"Failed to probe finalized source media duration.",
			{
				videoPath: artifacts.videoPath,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}

	for (const parseError of eventLog.parseErrors) {
		pushIssue(
			issues,
			"event-log-parse-error",
			"Event log contains an invalid JSON line.",
			parseError,
		);
	}

	for (const entry of entries) {
		if (!FAILURE_EVENTS.has(entry.event)) {
			continue;
		}
		const details = getDetails(entry);
		if (
			entry.event === "native-recording-degraded" &&
			details.severity &&
			details.severity !== "error"
		) {
			continue;
		}
		if (entry.event === "native-webcam-preview-frame-rejected" && details.failClosed !== true) {
			continue;
		}
		pushIssue(issues, entry.event, `Failure event recorded: ${entry.event}`, details);
	}

	for (const entry of entries) {
		if (entry.event !== "recording-companion-audio-sync-repaired") {
			continue;
		}
		const unsafeRepair = getUnsafeCompanionAudioRepair(getDetails(entry));
		if (!unsafeRepair) {
			continue;
		}
		pushIssue(
			issues,
			"recording-companion-audio-sync-unsafe-repair",
			"Companion audio was globally stretched beyond the current safe repair limit; start/end sync can hide middle-of-recording drift.",
			unsafeRepair,
		);
	}

	if (nativeMicrophoneRequested && !nativeMicrophoneFirstBuffer && !nativeMicrophoneUnavailable) {
		pushIssue(
			issues,
			"native-microphone-audio-missing-first-buffer",
			"Native microphone capture was selected, but no first microphone audio buffer was recorded.",
			{
				deviceEvent: getDetails(nativeMicrophoneDevice),
			},
		);
	}

	const unhealthyMicrophoneChunkTiming = microphoneChunkTiming.find(
		(summary) =>
			summary.status === "needs-review" ||
			((getNumber(summary.recordedGapCount) ?? 0) > 0 &&
				summary.status !== "pause-accounted"),
	);
	if (unhealthyMicrophoneChunkTiming) {
		pushIssue(
			issues,
			"browser-microphone-chunk-gap",
			"Browser microphone sidecar reported recorded audio chunk gaps after pause accounting.",
			unhealthyMicrophoneChunkTiming,
		);
	}

	if (
		preferredAudioForAudit !== null &&
		hasBrowserMicrophoneCompanionSidecar(preferredAudioForAudit)
	) {
		const durationForMicTiming =
			sourceMediaDurations?.videoDurationSeconds ?? screenFinalization?.duration ?? null;
		const minimumChunkTimingEvents =
			getMinimumBrowserMicChunkTimingEventCount(durationForMicTiming);
		if (microphoneChunkTiming.length === 0) {
			pushIssue(
				issues,
				"browser-microphone-chunk-timing-missing",
				"Browser microphone sidecar is present, but no chunk timing diagnostics were recorded to prove continuous mic capture.",
				{
					audioPaths: preferredAudioForAudit.paths,
					videoDurationSeconds: durationForMicTiming,
					minimumChunkTimingEvents,
				},
			);
		} else {
			const sparseChunkTiming = microphoneChunkTiming.find(
				(summary) => (getNumber(summary.eventCount) ?? 0) < minimumChunkTimingEvents,
			);
			if (sparseChunkTiming) {
				pushIssue(
					issues,
					"browser-microphone-chunk-timing-too-sparse",
					"Browser microphone sidecar chunk timing evidence is too sparse for the recording duration.",
					{
						...sparseChunkTiming,
						audioPaths: preferredAudioForAudit.paths,
						videoDurationSeconds: durationForMicTiming,
						minimumChunkTimingEvents,
						maxSecondsPerChunkTimingEvent:
							MAX_SECONDS_PER_BROWSER_MIC_CHUNK_TIMING_EVENT,
					},
				);
			}
		}
	}

	if (rendererPreviewIssues.count > 0) {
		pushIssue(
			warnings,
			"native-webcam-preview-renderer-issue",
			"The native recorder kept proof evidence, but the renderer preview surface reported stale or failed display frames.",
			rendererPreviewIssues as unknown as Record<string, unknown>,
		);
	}

	if (webcamVisualFreezeReviews.count > 0) {
		pushIssue(
			warnings,
			"native-webcam-visual-freeze-review",
			"The native recorder saw a short visually frozen webcam segment. The recording was saved, but this timestamp should be reviewed.",
			webcamVisualFreezeReviews as unknown as Record<string, unknown>,
		);
	}

	if (webcamCadenceSeverelyExceededTarget(webcamCadence)) {
		pushIssue(
			issues,
			"native-webcam-cadence-severely-exceeded-target",
			"Native webcam output cadence was far above the requested target frame rate. The recording may contain intermittent camera glitches.",
			webcamCadence as unknown as Record<string, unknown>,
		);
	} else if (webcamCadenceExceededTarget(webcamCadence)) {
		pushIssue(
			warnings,
			"native-webcam-cadence-exceeded-target",
			"Native webcam output cadence exceeded the requested target frame rate. This can increase encoding load and cause intermittent camera glitches.",
			webcamCadence as unknown as Record<string, unknown>,
		);
	}

	if (audioContinuityRepairs.count > 0) {
		pushIssue(
			warnings,
			"native-audio-continuity-repaired",
			"The native recorder inserted silence to keep audio sample time continuous after device callback gaps.",
			audioContinuityRepairs as unknown as Record<string, unknown>,
		);
	}

	if (webcamContinuityRepairs.count > 0) {
		pushIssue(
			warnings,
			"native-webcam-continuity-held-frames",
			"The native recorder held the last good webcam frame to keep the camera track continuous after device callback gaps.",
			webcamContinuityRepairs as unknown as Record<string, unknown>,
		);
	}

	if (!screenFinalization) {
		pushIssue(
			issues,
			"missing-screen-finalization",
			"Native screen writer finalization was not recorded.",
		);
	} else if (screenFinalization.writerStatus !== "completed") {
		pushIssue(
			issues,
			"screen-writer-not-completed",
			"Native screen writer did not finalize as completed.",
			screenFinalization as unknown as Record<string, unknown>,
		);
	}

	if (sawWebcamEvidence) {
		if (proof.count === 0) {
			pushIssue(
				issues,
				"missing-accepted-proof-preview",
				"Webcam was active, but no accepted proof-preview samples were recorded.",
			);
		}
		if (!proof.monotonic) {
			pushIssue(
				issues,
				"non-monotonic-accepted-proof-preview",
				"Accepted proof-preview samples were not monotonic.",
				proof as unknown as Record<string, unknown>,
			);
		}
		if (proof.largeGapCount > 0) {
			pushIssue(
				issues,
				"accepted-proof-preview-gap",
				"Accepted proof-preview samples contain a large webcam timestamp gap, which can produce a frozen or jumped facecam segment.",
				{
					maxAcceptedProofGapSeconds: MAX_ACCEPTED_PROOF_GAP_SECONDS,
					...proof,
				} as unknown as Record<string, unknown>,
			);
		}
		if (!webcamFinalization) {
			pushIssue(
				issues,
				"missing-webcam-finalization",
				"Webcam was active, but native webcam writer finalization was not recorded.",
			);
		} else if (webcamFinalization.writerStatus !== "completed") {
			pushIssue(
				issues,
				"webcam-writer-not-completed",
				"Native webcam writer did not finalize as completed.",
				webcamFinalization as unknown as Record<string, unknown>,
			);
		}

		const screenDuration = screenFinalization?.duration;
		const webcamDuration = webcamFinalization?.duration;
		const proofCoverageDuration = webcamDuration ?? screenDuration;
		if (
			typeof proofCoverageDuration === "number" &&
			Number.isFinite(proofCoverageDuration) &&
			proofCoverageDuration > 0
		) {
			const minimumProofCount = getMinimumAcceptedProofCount(proofCoverageDuration);
			if (proof.count < minimumProofCount) {
				pushIssue(
					issues,
					"accepted-proof-preview-too-sparse",
					"Accepted proof-preview samples were too sparse for the recording duration.",
					{
						proofCount: proof.count,
						minimumProofCount,
						proofCoverageDuration,
						maxSecondsPerProofSample: MAX_SECONDS_PER_ACCEPTED_PROOF_SAMPLE,
					},
				);
			}
		}
		if (
			screenDuration !== null &&
			webcamDuration !== null &&
			screenDuration &&
			webcamDuration
		) {
			const driftSeconds = Math.abs(screenDuration - webcamDuration);
			const allowedDriftSeconds = getAllowedDurationDriftSeconds(screenDuration);
			if (driftSeconds > allowedDriftSeconds) {
				pushIssue(
					issues,
					"screen-webcam-duration-drift",
					"Screen and webcam writer durations drifted beyond the native acceptance window.",
					{ screenDuration, webcamDuration, driftSeconds, allowedDriftSeconds },
				);
			}

			const lastAcceptedPts = getNumber(proof.last?.acceptedPts);
			if (lastAcceptedPts !== null) {
				const proofTailDriftSeconds = webcamDuration - lastAcceptedPts;
				if (proofTailDriftSeconds > MAX_ACCEPTED_PROOF_TAIL_DRIFT_SECONDS) {
					pushIssue(
						issues,
						"accepted-proof-ended-too-early",
						"Accepted proof-preview samples ended too far before webcam writer finalization.",
						{ webcamDuration, lastAcceptedPts, proofTailDriftSeconds },
					);
				}
			}
		}

		const firstAcceptedPts = getNumber(proof.first?.acceptedPts);
		if (firstAcceptedPts !== null && firstAcceptedPts > MAX_ACCEPTED_PROOF_HEAD_DRIFT_SECONDS) {
			pushIssue(
				issues,
				"accepted-proof-started-too-late",
				"Accepted proof-preview samples started too far after webcam recording began.",
				{
					firstAcceptedPts,
					allowedHeadDriftSeconds: MAX_ACCEPTED_PROOF_HEAD_DRIFT_SECONDS,
				},
			);
		}
		if (previewHandoff) {
			const handoffDetails = getDetails(previewHandoff);
			const selectionDetails = getDetails(recordingWebcamSelection);
			const recordingCaptureDetails = getDetails(recordingWebcamCaptureStarted);
			const handoffAcceptedProofCount = getNumber(handoffDetails.acceptedProofCount);
			const handoffLastAcceptedProof = isRecord(handoffDetails.lastAcceptedProof)
				? handoffDetails.lastAcceptedProof
				: null;
			const handoffHasVisibleWebcamFrame =
				typeof handoffDetails.hasVisibleWebcamFrame === "boolean"
					? handoffDetails.hasVisibleWebcamFrame
					: null;
			const handoffRequestedDeviceId = getNonEmptyString(handoffDetails.requestedDeviceId);
			const handoffRequestedLabel = getNonEmptyString(handoffDetails.requestedLabel);
			const handoffCaptureLabel = getNonEmptyString(handoffDetails.captureLabel);
			const recordingResolvedDeviceId = getNonEmptyString(selectionDetails.resolvedDeviceId);
			const recordingResolvedLabel = getNonEmptyString(selectionDetails.resolvedLabel);
			const recordingCaptureLabel = getNonEmptyString(recordingCaptureDetails.label);
			if (
				handoffAcceptedProofCount === null ||
				handoffAcceptedProofCount <= 0 ||
				handoffLastAcceptedProof === null
			) {
				pushIssue(
					issues,
					"preview-handoff-without-prior-proof",
					"Native webcam preview was handed to recording, but the preview session itself had not proven accepted webcam frames.",
					handoffDetails,
				);
			}
			if (handoffHasVisibleWebcamFrame !== true) {
				pushIssue(
					issues,
					"preview-handoff-without-prior-visible-video",
					"Native webcam preview was handed to recording, but the preview session itself had not proven visible webcam video.",
					handoffDetails,
				);
			}
			if (handoffRequestedDeviceId) {
				if (!recordingResolvedDeviceId) {
					pushIssue(
						issues,
						"preview-handoff-without-recording-device-identity",
						"Native webcam preview was tied to a specific device ID, but the recording helper did not resolve a webcam device ID.",
						{
							handoff: handoffDetails,
							recordingSelection: selectionDetails,
							recordingCapture: recordingCaptureDetails,
						},
					);
				} else if (handoffRequestedDeviceId !== recordingResolvedDeviceId) {
					pushIssue(
						issues,
						"preview-handoff-device-mismatch",
						"Native webcam preview and recording resolved different webcam device IDs.",
						{
							previewDeviceId: handoffRequestedDeviceId,
							recordingDeviceId: recordingResolvedDeviceId,
							handoff: handoffDetails,
							recordingSelection: selectionDetails,
						},
					);
				}
			}
			const handoffLabel = handoffRequestedLabel ?? handoffCaptureLabel;
			const recordingLabel = recordingResolvedLabel ?? recordingCaptureLabel;
			if (!handoffRequestedDeviceId && !handoffLabel) {
				pushIssue(
					issues,
					"preview-handoff-without-preview-camera-identity",
					"Native webcam preview was handed to recording, but the preview session did not record a device ID or capture label to prove which camera it monitored.",
					handoffDetails,
				);
			} else if (handoffLabel) {
				if (!recordingLabel) {
					pushIssue(
						issues,
						"preview-handoff-without-recording-camera-label",
						"Native webcam preview was tied to a camera label, but the recording helper did not record a resolved or captured camera label.",
						{
							previewLabel: handoffLabel,
							handoff: handoffDetails,
							recordingSelection: selectionDetails,
							recordingCapture: recordingCaptureDetails,
						},
					);
				} else if (!sameCameraIdentity(handoffLabel, recordingLabel)) {
					pushIssue(
						issues,
						"preview-handoff-label-mismatch",
						"Native webcam preview and recording used different webcam labels.",
						{
							previewLabel: handoffLabel,
							recordingLabel,
							handoff: handoffDetails,
							recordingSelection: selectionDetails,
							recordingCapture: recordingCaptureDetails,
						},
					);
				}
			}
			const firstVisiblePts = getNumber(getDetails(firstVisibleWebcamFrame).pts);
			if (firstAcceptedPts === null) {
				pushIssue(
					issues,
					"preview-handoff-without-recording-proof",
					"Native webcam preview was handed to recording, but the recording helper did not record accepted proof-preview evidence.",
					getDetails(previewHandoff),
				);
			} else if (firstAcceptedPts > MAX_PREVIEW_HANDOFF_REPROOF_SECONDS) {
				pushIssue(
					issues,
					"preview-handoff-reproof-started-too-late",
					"Native webcam preview was handed to recording, but the recording helper did not quickly re-prove accepted webcam frames.",
					{
						firstAcceptedPts,
						allowedReproofSeconds: MAX_PREVIEW_HANDOFF_REPROOF_SECONDS,
						handoff: getDetails(previewHandoff),
					},
				);
			}
			if (firstVisiblePts === null) {
				pushIssue(
					issues,
					"preview-handoff-without-visible-video",
					"Native webcam preview was handed to recording, but the recording helper did not record visible webcam video evidence.",
					getDetails(previewHandoff),
				);
			} else if (firstVisiblePts > MAX_PREVIEW_HANDOFF_REPROOF_SECONDS) {
				pushIssue(
					issues,
					"preview-handoff-visible-video-started-too-late",
					"Native webcam preview was handed to recording, but visible webcam video was not proven quickly enough.",
					{
						firstVisiblePts,
						allowedReproofSeconds: MAX_PREVIEW_HANDOFF_REPROOF_SECONDS,
						handoff: getDetails(previewHandoff),
					},
				);
			}
		}

		const firstAcceptedFrame = getNumber(proof.first?.acceptedFrame);
		if (
			firstAcceptedFrame !== null &&
			firstAcceptedFrame > MAX_ACCEPTED_PROOF_HEAD_FRAME_DRIFT
		) {
			pushIssue(
				issues,
				"accepted-proof-frame-started-too-late",
				"Accepted proof-preview frame count started too far after webcam recording began.",
				{
					firstAcceptedFrame,
					allowedHeadFrameDrift: MAX_ACCEPTED_PROOF_HEAD_FRAME_DRIFT,
				},
			);
		}

		const webcamFrames = webcamFinalization?.frames;
		const lastAcceptedFrame = getNumber(proof.last?.acceptedFrame);
		if (typeof webcamFrames === "number" && lastAcceptedFrame !== null) {
			const proofTailFrameDrift = webcamFrames - lastAcceptedFrame;
			if (proofTailFrameDrift > MAX_ACCEPTED_PROOF_TAIL_FRAME_DRIFT) {
				pushIssue(
					issues,
					"accepted-proof-frame-ended-too-early",
					"Accepted proof-preview frame count ended too far before webcam writer finalization.",
					{
						webcamFrames,
						lastAcceptedFrame,
						proofTailFrameDrift,
						allowedFrameDrift: MAX_ACCEPTED_PROOF_TAIL_FRAME_DRIFT,
					},
				);
			}
		}

		if (!findLast(entries, "native-webcam-sidecar-accepted")) {
			pushIssue(
				issues,
				"missing-webcam-sidecar-accepted",
				"Native webcam sidecar acceptance was not recorded.",
			);
		}
	}

	if (!findLast(entries, "native-screen-recording-accepted")) {
		pushIssue(
			issues,
			"missing-screen-accepted-event",
			"Native screen acceptance event was not found in the event log.",
		);
	}

	const latestDiagnostics =
		isRecord(diagnostics) && isRecord(diagnostics.latest) ? diagnostics.latest : null;
	const summary: RecordingRunAuditSummary = {
		eventCount: entries.length,
		eventCounts,
		sawWebcamEvidence,
		sourceMediaDurations,
		companionAudioDurations,
		proof,
		previewHandoff: {
			present: Boolean(previewHandoff),
			acceptedProofCount: getNumber(getDetails(previewHandoff).acceptedProofCount),
			lastAcceptedProof: isRecord(getDetails(previewHandoff).lastAcceptedProof)
				? (getDetails(previewHandoff).lastAcceptedProof as Record<string, unknown>)
				: null,
			hasVisibleWebcamFrame:
				typeof getDetails(previewHandoff).hasVisibleWebcamFrame === "boolean"
					? (getDetails(previewHandoff).hasVisibleWebcamFrame as boolean)
					: null,
			requestedDeviceId: getNonEmptyString(getDetails(previewHandoff).requestedDeviceId),
			requestedLabel: getNonEmptyString(getDetails(previewHandoff).requestedLabel),
			captureLabel: getNonEmptyString(getDetails(previewHandoff).captureLabel),
			firstVisibleFrame: isRecord(firstVisibleWebcamFrame?.details)
				? (firstVisibleWebcamFrame.details as Record<string, unknown>)
				: null,
		},
		recordingWebcamIdentity: {
			selectedDeviceId: getNonEmptyString(
				getDetails(recordingWebcamSelection).selectedDeviceId,
			),
			resolvedDeviceId: getNonEmptyString(
				getDetails(recordingWebcamSelection).resolvedDeviceId,
			),
			resolvedLabel: getNonEmptyString(getDetails(recordingWebcamSelection).resolvedLabel),
			captureLabel: getNonEmptyString(getDetails(recordingWebcamCaptureStarted).label),
		},
		webcamCadence,
		webcamVisualFreezeReviews,
		audioContinuityRepairs,
		webcamContinuityRepairs,
		nativeMicrophone: {
			requested: nativeMicrophoneRequested,
			firstBufferWritten: nativeMicrophoneFirstBuffer !== null,
			unavailable: nativeMicrophoneUnavailable !== null,
			deviceEvent: nativeMicrophoneDevice ? getDetails(nativeMicrophoneDevice) : null,
			firstBuffer: nativeMicrophoneFirstBuffer
				? getDetails(nativeMicrophoneFirstBuffer)
				: null,
		},
		microphoneChunkTiming,
		rendererPreviewIssues,
		screenFinalization,
		webcamFinalization,
		diagnosticsLatestPhase: latestDiagnostics?.phase ?? null,
		diagnosticsExpectedDurationMs: latestDiagnostics?.expectedDurationMs ?? null,
	};

	return {
		status: issues.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass",
		paths: artifacts,
		issues,
		warnings,
		summary,
	};
}

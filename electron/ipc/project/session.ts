import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { RECORDING_SESSION_MANIFEST_SUFFIX } from "../constants";
import { auditRecordingRun } from "../recording/auditRecordingRun";
import type { RecordingSessionData, RecordingSessionManifest } from "../types";
import { normalizeVideoSourcePath, parseJsonWithByteOrderMark } from "../utils";

const LINKED_WEBCAM_SUPPRESSING_AUDIT_ISSUES = new Set([
	"missing-accepted-proof-preview",
	"non-monotonic-accepted-proof-preview",
	"accepted-proof-ended-too-early",
	"accepted-proof-frame-ended-too-early",
	"missing-webcam-finalization",
	"webcam-writer-not-completed",
	"screen-webcam-duration-drift",
	"missing-webcam-sidecar-accepted",
	"native-webcam-sidecar-rejected",
	"native-webcam-sidecar-missing",
	"native-webcam-capture-stats-stale",
	"native-webcam-capture-low-cadence-sustained",
	"native-webcam-visual-stall-fail-closed",
	"native-webcam-proof-preview-stale",
	"native-webcam-proof-preview-lagging",
	"native-webcam-proof-preview-invalid",
	"native-webcam-proof-preview-publish-failed",
	"native-webcam-pipeline-stalled",
	"native-webcam-capture-disabled",
	"native-webcam-device-not-found",
]);

function normalizeRecordingTimeOffsetMs(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

type CaptureStat = {
	timestampSec: number;
	lastPtsSec: number;
};

type FirstFrameEvent = {
	timestampSec: number;
	ptsSec: number;
};

function getRecordingEventLogPath(videoPath: string) {
	return videoPath.replace(/\.[^.]+$/u, ".recordly-events.jsonl");
}

function parseFiniteNumber(value: unknown): number | null {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function interpolateCapturePts(stats: CaptureStat[], timestampSec: number): number | null {
	if (stats.length === 0) {
		return null;
	}

	let previous: CaptureStat | null = null;
	for (const stat of stats) {
		if (Math.abs(stat.timestampSec - timestampSec) <= 0.001) {
			return stat.lastPtsSec;
		}
		if (stat.timestampSec > timestampSec) {
			if (!previous) {
				return null;
			}
			const span = stat.timestampSec - previous.timestampSec;
			if (span <= 0) {
				return stat.lastPtsSec;
			}
			const progress = (timestampSec - previous.timestampSec) / span;
			return previous.lastPtsSec + (stat.lastPtsSec - previous.lastPtsSec) * progress;
		}
		previous = stat;
	}

	return null;
}

export async function estimateRecordingWebcamTimeOffsetMs(
	videoPath: string,
): Promise<number | null> {
	const eventLogPath = getRecordingEventLogPath(videoPath);
	let content: string;
	try {
		content = await fs.readFile(eventLogPath, "utf-8");
	} catch {
		return null;
	}

	const videoStats: CaptureStat[] = [];
	const webcamStats: CaptureStat[] = [];
	let videoFirstFrame: FirstFrameEvent | null = null;
	let webcamFirstFrame: FirstFrameEvent | null = null;

	for (const line of content.split(/\r?\n/u)) {
		if (!line.trim()) {
			continue;
		}

		let entry: {
			timestamp?: unknown;
			event?: unknown;
			details?: Record<string, unknown>;
		};
		try {
			entry = parseJsonWithByteOrderMark(line);
		} catch {
			continue;
		}

		const timestamp =
			typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) / 1000 : NaN;
		if (!Number.isFinite(timestamp) || typeof entry.event !== "string") {
			continue;
		}

		const details = entry.details ?? {};
		if (entry.event === "native-video-capture-stats") {
			const lastPts = parseFiniteNumber(details.lastPts);
			if (lastPts !== null) {
				videoStats.push({ timestampSec: timestamp, lastPtsSec: lastPts });
			}
		} else if (entry.event === "native-webcam-capture-stats") {
			const lastPts = parseFiniteNumber(details.lastPts);
			if (lastPts !== null) {
				webcamStats.push({ timestampSec: timestamp, lastPtsSec: lastPts });
			}
		} else if (entry.event === "native-video-first-frame-written") {
			const pts = parseFiniteNumber(details.pts);
			if (pts !== null) {
				videoFirstFrame = { timestampSec: timestamp, ptsSec: pts };
			}
		} else if (entry.event === "native-webcam-first-visible-frame-written") {
			const pts = parseFiniteNumber(details.pts);
			if (pts !== null) {
				webcamFirstFrame = { timestampSec: timestamp, ptsSec: pts };
			}
		}
	}

	videoStats.sort((a, b) => a.timestampSec - b.timestampSec);
	webcamStats.sort((a, b) => a.timestampSec - b.timestampSec);

	const captureDiffs = videoStats
		.map((videoStat) => {
			const webcamPts = interpolateCapturePts(webcamStats, videoStat.timestampSec);
			if (webcamPts === null) {
				return null;
			}
			return videoStat.lastPtsSec - webcamPts;
		})
		.filter((diff): diff is number => diff !== null && Math.abs(diff) <= 10);

	if (captureDiffs.length >= 3) {
		const estimated = median(captureDiffs);
		if (estimated !== null && Math.abs(estimated) >= 0.05) {
			return Math.round(estimated * 1000);
		}
	}

	if (videoFirstFrame && webcamFirstFrame) {
		const wallDeltaSec = webcamFirstFrame.timestampSec - videoFirstFrame.timestampSec;
		const ptsDeltaSec = webcamFirstFrame.ptsSec - videoFirstFrame.ptsSec;
		const estimated = wallDeltaSec - ptsDeltaSec;
		if (Number.isFinite(estimated) && Math.abs(estimated) >= 0.05 && Math.abs(estimated) <= 10) {
			return Math.round(estimated * 1000);
		}
	}

	return null;
}

export function getRecordingSessionManifestPath(videoPath: string) {
	const extension = path.extname(videoPath);
	const baseName = path.basename(videoPath, extension);
	return path.join(path.dirname(videoPath), `${baseName}${RECORDING_SESSION_MANIFEST_SUFFIX}`);
}

export async function persistRecordingSessionManifest(
	session: RecordingSessionData,
): Promise<void> {
	const normalizedVideoPath = normalizeVideoSourcePath(session.videoPath);
	if (!normalizedVideoPath) {
		return;
	}

	const normalizedWebcamPath = normalizeVideoSourcePath(session.webcamPath ?? null);
	const manifestPath = getRecordingSessionManifestPath(normalizedVideoPath);

	const manifest: RecordingSessionManifest = {
		version: 2,
		videoFileName: path.basename(normalizedVideoPath),
		webcamFileName: normalizedWebcamPath ? path.basename(normalizedWebcamPath) : null,
		timeOffsetMs: normalizeRecordingTimeOffsetMs(session.timeOffsetMs),
	};

	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

export async function resolveRecordingSessionManifest(
	videoPath?: string | null,
): Promise<RecordingSessionData | null> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const manifestPath = getRecordingSessionManifestPath(normalizedVideoPath);

	try {
		const content = await fs.readFile(manifestPath, "utf-8");
		const parsed = parseJsonWithByteOrderMark<Partial<RecordingSessionManifest>>(content);
		if (parsed.version !== 1 && parsed.version !== 2) {
			return null;
		}

		const webcamFileName =
			typeof parsed.webcamFileName === "string" && parsed.webcamFileName.trim()
				? parsed.webcamFileName.trim()
				: null;

		if (!webcamFileName) {
			return {
				videoPath: normalizedVideoPath,
				webcamPath: null,
				timeOffsetMs: normalizeRecordingTimeOffsetMs(parsed.timeOffsetMs),
			};
		}

		const webcamPath = path.join(path.dirname(normalizedVideoPath), webcamFileName);
		const webcamExists = await fs
			.access(webcamPath, fsConstants.F_OK)
			.then(() => true)
				.catch(() => false);
		const manifestTimeOffsetMs = normalizeRecordingTimeOffsetMs(parsed.timeOffsetMs);
		const estimatedTimeOffsetMs =
			webcamExists && manifestTimeOffsetMs === 0
				? await estimateRecordingWebcamTimeOffsetMs(normalizedVideoPath)
				: null;

		return {
			videoPath: normalizedVideoPath,
			webcamPath: webcamExists ? webcamPath : null,
			timeOffsetMs: estimatedTimeOffsetMs ?? manifestTimeOffsetMs,
		};
	} catch {
		return null;
	}
}

export async function resolveLinkedWebcamPath(videoPath?: string | null): Promise<string | null> {
	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const extension = path.extname(normalizedVideoPath);
	const baseName = path.basename(normalizedVideoPath, extension);
	if (!baseName || baseName.endsWith("-webcam")) {
		return null;
	}

	const candidateExtensions = Array.from(
		new Set([extension, ".webm", ".mp4", ".mov", ".mkv", ".avi"].filter(Boolean)),
	);

	for (const candidateExtension of candidateExtensions) {
		const candidatePath = path.join(
			path.dirname(normalizedVideoPath),
			`${baseName}-webcam${candidateExtension}`,
		);

		try {
			await fs.access(candidatePath, fsConstants.F_OK);
			return candidatePath;
		} catch {
			continue;
		}
	}

	return null;
}

async function shouldSuppressLinkedWebcamFallback(videoPath: string): Promise<boolean> {
	const eventLogPath = videoPath.replace(/\.[^.]+$/u, ".recordly-events.jsonl");
	const eventLogExists = await fs
		.access(eventLogPath, fsConstants.F_OK)
		.then(() => true)
		.catch(() => false);
	if (!eventLogExists) {
		return false;
	}

	const audit = await auditRecordingRun(videoPath).catch(() => null);
	if (!audit || audit.status !== "fail") {
		return false;
	}

	return audit.issues.some((issue) => LINKED_WEBCAM_SUPPRESSING_AUDIT_ISSUES.has(issue.code));
}

export async function resolveRecordingSession(
	videoPath?: string | null,
	options: { allowLinkedWebcamFallback?: boolean } = {},
): Promise<RecordingSessionData | null> {
	const manifestSession = await resolveRecordingSessionManifest(videoPath);
	if (manifestSession) {
		return manifestSession;
	}

	const normalizedVideoPath = normalizeVideoSourcePath(videoPath);
	if (!normalizedVideoPath) {
		return null;
	}

	const allowLinkedWebcamFallback =
		options.allowLinkedWebcamFallback !== false &&
		!(await shouldSuppressLinkedWebcamFallback(normalizedVideoPath));
	const linkedWebcamPath = allowLinkedWebcamFallback
		? await resolveLinkedWebcamPath(normalizedVideoPath)
		: null;
	const estimatedTimeOffsetMs = linkedWebcamPath
		? await estimateRecordingWebcamTimeOffsetMs(normalizedVideoPath)
		: null;
	return {
		videoPath: normalizedVideoPath,
		webcamPath: linkedWebcamPath,
		...(estimatedTimeOffsetMs !== null ? { timeOffsetMs: estimatedTimeOffsetMs } : {}),
	};
}

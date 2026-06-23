import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegBinaryPath, getFfprobeBinaryPath } from "../ffmpeg/binary";
import { buildAtempoFilters, formatFfmpegSeconds } from "../ffmpeg/filters";
import { appendRecordingEventLogEntry, getRecordingEventLogPath } from "./recordingEventLog";

const execFileAsync = promisify(execFile);

export const RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS = 0.05;
export const RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_SECONDS = 1.5;
export const RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_RATIO = 0.0015;

export type RecordingSourceAudioSyncPlan =
	| {
			action: "none";
			reason: "missing-audio" | "invalid-duration" | "within-tolerance";
			videoDurationSeconds: number | null;
			audioDurationSeconds: number | null;
			driftSeconds: number | null;
			tempoRatio: 1;
	  }
	| {
			action: "repair";
			reason: "pad" | "trim";
			videoDurationSeconds: number;
			audioDurationSeconds: number;
			driftSeconds: number;
			tempoRatio: number;
	  }
	| {
			action: "reject";
			reason: "unsafe-short-audio-mismatch";
			videoDurationSeconds: number;
			audioDurationSeconds: number;
			driftSeconds: number;
			tempoRatio: 1;
	  };

export type RecordingSourceAudioVideoDurations = {
	videoDurationSeconds: number | null;
	audioDurationSeconds: number | null;
};

export type NativeCompanionAudioSyncTelemetry = {
	videoDurationSeconds: number;
	audioDurationSeconds: number;
	videoWriterStatus: string;
	audioWriterStatus: string;
	trackKind: "mic" | "system";
	source?: "native-output" | "event-log";
};

function finitePositive(value: unknown) {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function roundSeconds(value: number) {
	return Math.round(value * 1000) / 1000;
}

function recordingSessionIdForVideoPath(videoPath: string) {
	const baseName = path.basename(videoPath, path.extname(videoPath));
	return baseName.startsWith("recording-") ? baseName.slice("recording-".length) : baseName;
}

async function replaceFileWithTemp(tempPath: string, targetPath: string) {
	await fs.rm(targetPath, { force: true });
	await fs.rename(tempPath, targetPath);
}

function parseNativeHelperOutputScalar(line: string, key: string) {
	const pattern = new RegExp(`(?:^|\\s)${key}=("[^"]*"|'[^']*'|\\S+)`);
	const match = pattern.exec(line);
	if (!match) {
		return null;
	}
	const rawValue = match[1];
	const unquoted =
		(rawValue.startsWith('"') && rawValue.endsWith('"')) ||
		(rawValue.startsWith("'") && rawValue.endsWith("'"))
			? rawValue.slice(1, -1)
			: rawValue;
	return unquoted;
}

function parseNativeHelperOutputNumber(line: string, key: string) {
	const value = parseNativeHelperOutputScalar(line, key);
	if (value === null) {
		return null;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function findLastNativeFinalizationLine(output: string, prefix: string) {
	let finalLine: string | null = null;
	for (const line of output.split(/\r?\n/u)) {
		if (line.trimStart().startsWith(prefix)) {
			finalLine = line;
		}
	}
	return finalLine;
}

export function getTrustedNativeCompanionAudioSyncTelemetry({
	nativeCaptureOutput,
	trackKind,
}: {
	nativeCaptureOutput?: string | null;
	trackKind: "mic" | "system";
}): NativeCompanionAudioSyncTelemetry | null {
	if (!nativeCaptureOutput || trackKind !== "mic") {
		return null;
	}

	const videoLine = findLastNativeFinalizationLine(
		nativeCaptureOutput,
		"VIDEO_RECORDING_FINALIZED ",
	);
	const audioLine = findLastNativeFinalizationLine(
		nativeCaptureOutput,
		"MICROPHONE_RECORDING_FINALIZED ",
	);
	if (!videoLine || !audioLine) {
		return null;
	}

	const videoWriterStatus =
		parseNativeHelperOutputScalar(videoLine, "writerStatus") ?? "";
	const audioWriterStatus =
		parseNativeHelperOutputScalar(audioLine, "writerStatus") ?? "";
	if (videoWriterStatus !== "completed" || audioWriterStatus !== "completed") {
		return null;
	}

	const videoDurationSeconds = parseNativeHelperOutputNumber(videoLine, "duration");
	const audioDurationSeconds = parseNativeHelperOutputNumber(audioLine, "duration");
	if (
		videoDurationSeconds === null ||
		audioDurationSeconds === null ||
		videoDurationSeconds <= 0 ||
		audioDurationSeconds <= 0
	) {
		return null;
	}

	return {
		videoDurationSeconds,
		audioDurationSeconds,
		videoWriterStatus,
		audioWriterStatus,
		trackKind,
		source: "native-output",
	};
}

function getDetailsFromEventLogEntry(entry: unknown) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return null;
	}
	const details = (entry as { details?: unknown }).details;
	return details && typeof details === "object" && !Array.isArray(details)
		? (details as Record<string, unknown>)
		: null;
}

function getLastEventDetails(entries: unknown[], eventName: string) {
	let lastDetails: Record<string, unknown> | null = null;
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			(entry as { event?: unknown }).event !== eventName
		) {
			continue;
		}
		lastDetails = getDetailsFromEventLogEntry(entry);
	}
	return lastDetails;
}

export async function getTrustedNativeCompanionAudioSyncTelemetryFromEventLog({
	videoPath,
	trackKind,
}: {
	videoPath: string;
	trackKind: "mic" | "system";
}): Promise<NativeCompanionAudioSyncTelemetry | null> {
	if (trackKind !== "mic") {
		return null;
	}

	const eventLogPath = getRecordingEventLogPath(
		path.dirname(videoPath),
		recordingSessionIdForVideoPath(videoPath),
	);
	let lines: string[];
	try {
		lines = (await fs.readFile(eventLogPath, "utf8")).split(/\r?\n/u);
	} catch {
		return null;
	}

	const entries: unknown[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			entries.push(JSON.parse(trimmed) as unknown);
		} catch {
			// Ignore partial/corrupt event-log lines; missing telemetry simply falls
			// back to the normal ffprobe-based safety plan.
		}
	}

	const videoDetails = getLastEventDetails(entries, "native-video-recording-finalized");
	const audioDetails = getLastEventDetails(entries, "native-microphone-recording-finalized");
	if (!videoDetails || !audioDetails) {
		return null;
	}

	const videoWriterStatus = typeof videoDetails.writerStatus === "string" ? videoDetails.writerStatus : "";
	const audioWriterStatus = typeof audioDetails.writerStatus === "string" ? audioDetails.writerStatus : "";
	if (videoWriterStatus !== "completed" || audioWriterStatus !== "completed") {
		return null;
	}

	const videoDurationSeconds = finitePositive(videoDetails.duration);
	const audioDurationSeconds = finitePositive(audioDetails.duration);
	if (videoDurationSeconds === null || audioDurationSeconds === null) {
		return null;
	}

	return {
		videoDurationSeconds,
		audioDurationSeconds,
		videoWriterStatus,
		audioWriterStatus,
		trackKind,
		source: "event-log",
	};
}

export function getRecordingSourceAudioSyncPlan({
	videoDurationSeconds,
	audioDurationSeconds,
}: RecordingSourceAudioVideoDurations): RecordingSourceAudioSyncPlan {
	if (videoDurationSeconds === null || audioDurationSeconds === null) {
		return {
			action: "none",
			reason: audioDurationSeconds === null ? "missing-audio" : "invalid-duration",
			videoDurationSeconds,
			audioDurationSeconds,
			driftSeconds: null,
			tempoRatio: 1,
		};
	}

	if (
		!Number.isFinite(videoDurationSeconds) ||
		!Number.isFinite(audioDurationSeconds) ||
		videoDurationSeconds <= 0 ||
		audioDurationSeconds <= 0
	) {
		return {
			action: "none",
			reason: "invalid-duration",
			videoDurationSeconds,
			audioDurationSeconds,
			driftSeconds: null,
			tempoRatio: 1,
		};
	}

	const driftSeconds = roundSeconds(videoDurationSeconds - audioDurationSeconds);
	if (Math.abs(driftSeconds) <= RECORDING_SOURCE_AUDIO_SYNC_TOLERANCE_SECONDS) {
		return {
			action: "none",
			reason: "within-tolerance",
			videoDurationSeconds,
			audioDurationSeconds,
			driftSeconds,
			tempoRatio: 1,
		};
	}

	if (driftSeconds < 0) {
		return {
			action: "repair",
			reason: "trim",
			videoDurationSeconds,
			audioDurationSeconds,
			driftSeconds,
			tempoRatio: 1,
		};
	}

	const relativeDrift = driftSeconds / videoDurationSeconds;
	if (
		driftSeconds > RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_SECONDS &&
		relativeDrift > RECORDING_SOURCE_AUDIO_MAX_TEMPO_DRIFT_RATIO
	) {
		return {
			action: "reject",
			reason: "unsafe-short-audio-mismatch",
			videoDurationSeconds,
			audioDurationSeconds,
			driftSeconds,
			tempoRatio: 1,
		};
	}

	return {
		action: "repair",
		reason: "pad",
		videoDurationSeconds,
		audioDurationSeconds,
		driftSeconds,
		tempoRatio: 1,
	};
}

export function buildRecordingSourceAudioSyncFilter({
	videoDurationSeconds,
	tempoRatio,
}: {
	videoDurationSeconds: number;
	tempoRatio: number;
}) {
	const outputDurationMs = Math.round(videoDurationSeconds * 1000);
	const filters = [
		...buildAtempoFilters(tempoRatio),
		"apad",
		`atrim=duration=${formatFfmpegSeconds(outputDurationMs)}`,
		"aresample=async=1:first_pts=0",
		"asetpts=PTS-STARTPTS",
	];
	return `[0:a]${filters.join(",")}[aout_sync]`;
}

export function buildRecordingAudioOnlySyncArgs({
	inputPath,
	outputPath,
	videoDurationSeconds,
	tempoRatio,
}: {
	inputPath: string;
	outputPath: string;
	videoDurationSeconds: number;
	tempoRatio: number;
}) {
	const duration = formatFfmpegSeconds(Math.round(videoDurationSeconds * 1000));
	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		inputPath,
		"-filter_complex",
		buildRecordingSourceAudioSyncFilter({ videoDurationSeconds, tempoRatio }),
		"-map",
		"[aout_sync]",
		"-c:a",
		"aac",
		"-b:a",
		"192k",
		"-t",
		duration,
		outputPath,
	];
}

export function parseRecordingSourceAudioVideoDurations(
	ffprobeJson: string,
): RecordingSourceAudioVideoDurations {
	let parsed: {
		streams?: Array<{ codec_type?: unknown; duration?: unknown }>;
		format?: { duration?: unknown };
	};
	try {
		parsed = JSON.parse(ffprobeJson);
	} catch {
		return { videoDurationSeconds: null, audioDurationSeconds: null };
	}

	const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
	const videoStream = streams.find((stream) => stream.codec_type === "video");
	const audioStream = streams.find((stream) => stream.codec_type === "audio");
	return {
		videoDurationSeconds:
			finitePositive(videoStream?.duration) ?? finitePositive(parsed.format?.duration),
		audioDurationSeconds: finitePositive(audioStream?.duration),
	};
}

export async function probeRecordingSourceAudioVideoDurations(
	videoPath: string,
): Promise<RecordingSourceAudioVideoDurations> {
	const result = await execFileAsync(
		getFfprobeBinaryPath(),
		["-v", "error", "-print_format", "json", "-show_format", "-show_streams", videoPath],
		{ timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
	);
	return parseRecordingSourceAudioVideoDurations(result.stdout);
}

export async function probeRecordingAudioDurationSeconds(audioPath: string) {
	const result = await execFileAsync(
		getFfprobeBinaryPath(),
		["-v", "error", "-print_format", "json", "-show_format", "-show_streams", audioPath],
		{ timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
	);
	const parsed = parseRecordingSourceAudioVideoDurations(result.stdout);
	return parsed.audioDurationSeconds;
}

async function recordSourceAudioSyncEvent({
	videoPath,
	event,
	details,
}: {
	videoPath: string;
	event: string;
	details: Record<string, unknown>;
}) {
	try {
		await appendRecordingEventLogEntry({
			recordingsDir: path.dirname(videoPath),
			sessionId: recordingSessionIdForVideoPath(videoPath),
			event,
			details: {
				videoPath,
				...details,
			},
		});
	} catch (error) {
		console.warn("[recording-source-audio-sync] Failed to write event:", error);
	}
}

export async function repairRecordingCompanionAudioSyncIfNeeded({
	videoPath,
	audioPath,
	trackKind,
	nativeCaptureOutput,
}: {
	videoPath: string;
	audioPath: string;
	trackKind: "mic" | "system";
	nativeCaptureOutput?: string | null;
}) {
	const [{ videoDurationSeconds }, audioDurationSeconds] = await Promise.all([
		probeRecordingSourceAudioVideoDurations(videoPath),
		probeRecordingAudioDurationSeconds(audioPath),
	]);
	const before = { videoDurationSeconds, audioDurationSeconds };
	const plan = getRecordingSourceAudioSyncPlan(before);
	const trustedNativeTelemetry =
		getTrustedNativeCompanionAudioSyncTelemetry({
			nativeCaptureOutput,
			trackKind,
		}) ??
		(await getTrustedNativeCompanionAudioSyncTelemetryFromEventLog({
			videoPath,
			trackKind,
		}));
	const trustedNativePlan = trustedNativeTelemetry
		? getRecordingSourceAudioSyncPlan(trustedNativeTelemetry)
		: null;
	const eventDetails = {
		...plan,
		audioPath,
		trackKind,
	};

	if (
		trustedNativeTelemetry &&
		trustedNativePlan?.action === "none" &&
		trustedNativePlan.reason === "within-tolerance" &&
		plan.action !== "none"
	) {
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-companion-audio-sync-skipped-native-telemetry",
			details: {
				reason: "native-finalization-within-tolerance",
				audioPath,
				trackKind,
				ffprobePlan: plan,
				nativeTelemetry: trustedNativeTelemetry,
				nativePlan: trustedNativePlan,
			},
		});
		return {
			plan: trustedNativePlan,
			before,
			after: before,
			repaired: false,
		};
	}

	if (plan.action === "none") {
		if (plan.reason === "missing-audio" || plan.reason === "invalid-duration") {
			await recordSourceAudioSyncEvent({
				videoPath,
				event: "recording-companion-audio-sync-rejected",
				details: eventDetails,
			});
			throw new Error(`Companion ${trackKind} audio is missing or has invalid duration`);
		}
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-companion-audio-sync-ok",
			details: eventDetails,
		});
		return { plan, before, after: before, repaired: false };
	}

	if (plan.action === "reject") {
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-companion-audio-sync-rejected",
			details: eventDetails,
		});
		throw new Error(
			`Companion ${trackKind} audio/video mismatch is too large to repair safely: video=${plan.videoDurationSeconds.toFixed(3)}s audio=${plan.audioDurationSeconds.toFixed(3)}s drift=${plan.driftSeconds.toFixed(3)}s`,
		);
	}

	const tempPath = `${audioPath}.audio-sync-${process.pid}-${Date.now()}.m4a`;
	try {
		await execFileAsync(
			getFfmpegBinaryPath(),
			buildRecordingAudioOnlySyncArgs({
				inputPath: audioPath,
				outputPath: tempPath,
				videoDurationSeconds: plan.videoDurationSeconds,
				tempoRatio: plan.tempoRatio,
			}),
			{ timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
		);
		const after = {
			videoDurationSeconds: plan.videoDurationSeconds,
			audioDurationSeconds: await probeRecordingAudioDurationSeconds(tempPath),
		};
		const afterPlan = getRecordingSourceAudioSyncPlan(after);
		if (afterPlan.action !== "none") {
			throw new Error(
				`Repaired companion ${trackKind} audio still has drift: ${JSON.stringify(afterPlan)}`,
			);
		}

		await replaceFileWithTemp(tempPath, audioPath);
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-companion-audio-sync-repaired",
			details: { ...eventDetails, after },
		});
		return { plan, before, after, repaired: true };
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-companion-audio-sync-repair-failed",
			details: {
				...eventDetails,
				error: error instanceof Error ? error.message : String(error),
			},
		});
		throw error;
	}
}

export async function repairRecordingSourceAudioSyncIfNeeded(videoPath: string) {
	const before = await probeRecordingSourceAudioVideoDurations(videoPath);
	const plan = getRecordingSourceAudioSyncPlan(before);

	if (plan.action === "none") {
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-source-audio-sync-ok",
			details: plan,
		});
		return { plan, before, after: before, repaired: false };
	}

	if (plan.action === "reject") {
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-source-audio-sync-rejected",
			details: plan,
		});
		throw new Error(
			`Recording source audio/video mismatch is too large to repair safely: video=${plan.videoDurationSeconds.toFixed(3)}s audio=${plan.audioDurationSeconds.toFixed(3)}s drift=${plan.driftSeconds.toFixed(3)}s`,
		);
	}

	const tempPath = `${videoPath}.audio-sync-${process.pid}-${Date.now()}.mp4`;
	const filter = buildRecordingSourceAudioSyncFilter({
		videoDurationSeconds: plan.videoDurationSeconds,
		tempoRatio: plan.tempoRatio,
	});

	try {
		await execFileAsync(
			getFfmpegBinaryPath(),
			[
				"-y",
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				videoPath,
				"-filter_complex",
				filter,
				"-map",
				"0:v:0",
				"-map",
				"[aout_sync]",
				"-c:v",
				"copy",
				"-c:a",
				"aac",
				"-b:a",
				"192k",
				"-t",
				formatFfmpegSeconds(Math.round(plan.videoDurationSeconds * 1000)),
				"-movflags",
				"+faststart",
				tempPath,
			],
			{ timeout: 20 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
		);

		const after = await probeRecordingSourceAudioVideoDurations(tempPath);
		const afterPlan = getRecordingSourceAudioSyncPlan(after);
		if (afterPlan.action !== "none") {
			throw new Error(
				`Repaired recording still has audio/video drift: ${JSON.stringify(afterPlan)}`,
			);
		}

		await replaceFileWithTemp(tempPath, videoPath);
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-source-audio-sync-repaired",
			details: { ...plan, after },
		});
		return { plan, before, after, repaired: true };
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		await recordSourceAudioSyncEvent({
			videoPath,
			event: "recording-source-audio-sync-repair-failed",
			details: {
				...plan,
				error: error instanceof Error ? error.message : String(error),
			},
		});
		throw error;
	}
}

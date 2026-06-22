import type { AudioRegion, WebcamOverlaySettings } from "./types";

export type WebcamReplacementSyncMode = "camera-only" | "camera-and-audio";

export type WebcamReplacementAudioRegionDraft = Omit<AudioRegion, "id">;

export interface WebcamReplacementSyncApplyResult {
	webcam: Pick<WebcamOverlaySettings, "enabled" | "sourcePath" | "timeOffsetMs">;
	audioRegion: WebcamReplacementAudioRegionDraft | null;
}

export interface BuildWebcamReplacementSyncResultInput {
	sourcePath: string;
	timeOffsetMs: number;
	mode: WebcamReplacementSyncMode;
	timelineDurationMs: number;
	replacementDurationMs?: number | null;
	audioTrackIndex?: number;
}

function finiteMs(value: number | null | undefined, fallback: number): number {
	return Number.isFinite(value) ? Math.round(value ?? fallback) : fallback;
}

export function buildWebcamReplacementSyncResult({
	sourcePath,
	timeOffsetMs,
	mode,
	timelineDurationMs,
	replacementDurationMs,
	audioTrackIndex = 0,
}: BuildWebcamReplacementSyncResultInput): WebcamReplacementSyncApplyResult {
	const offsetMs = finiteMs(timeOffsetMs, 0);
	const safeTimelineDurationMs = Math.max(1, finiteMs(timelineDurationMs, 1));
	const safeReplacementDurationMs = Math.max(
		1,
		finiteMs(replacementDurationMs, safeTimelineDurationMs),
	);

	const webcam = {
		enabled: true,
		sourcePath,
		timeOffsetMs: offsetMs,
	};

	if (mode !== "camera-and-audio") {
		return { webcam, audioRegion: null };
	}

	const sourceStartMs = Math.max(0, -offsetMs);
	const timelineStartMs = Math.max(0, offsetMs);

	if (
		sourceStartMs >= safeReplacementDurationMs ||
		timelineStartMs >= safeTimelineDurationMs
	) {
		return { webcam, audioRegion: null };
	}

	const availableReplacementMs = safeReplacementDurationMs - sourceStartMs;
	const availableTimelineMs = safeTimelineDurationMs - timelineStartMs;
	const audioDurationMs = Math.max(1, Math.min(availableReplacementMs, availableTimelineMs));

	return {
		webcam,
		audioRegion: {
			startMs: timelineStartMs,
			endMs: timelineStartMs + audioDurationMs,
			sourceStartMs,
			audioPath: sourcePath,
			volume: 1,
			normalize: false,
			trackIndex: Math.max(0, Math.floor(audioTrackIndex)),
		},
	};
}

import { clampMediaTimeToDuration } from "@/lib/mediaTiming";

const MAX_WEBCAM_DURATION_NORMALIZATION_DRIFT_SECONDS = 2;
const MAX_WEBCAM_DURATION_NORMALIZATION_DRIFT_RATIO = 0.005;
const MIN_WEBCAM_DURATION_NORMALIZATION_DRIFT_SECONDS = 0.05;

function finitePositiveSeconds(value: number | null | undefined): number | null {
	return Number.isFinite(value) && (value ?? 0) > 0 ? (value ?? 0) : null;
}

function getWebcamDurationDriftToleranceSeconds(timelineDuration: number): number {
	return Math.max(
		MIN_WEBCAM_DURATION_NORMALIZATION_DRIFT_SECONDS,
		Math.min(
			MAX_WEBCAM_DURATION_NORMALIZATION_DRIFT_SECONDS,
			timelineDuration * MAX_WEBCAM_DURATION_NORMALIZATION_DRIFT_RATIO,
		),
	);
}

/**
 * Maps the editor timeline time to the corresponding webcam media timestamp,
 * accounting for any recorded webcam start offset, small capture clock drift,
 * and media duration clamps.
 */
export function getWebcamMediaTargetTimeSeconds({
	currentTime,
	webcamDuration,
	timeOffsetMs,
	timelineDuration,
}: {
	currentTime: number;
	webcamDuration?: number | null;
	timeOffsetMs?: number | null;
	timelineDuration?: number | null;
}): number {
	const safeOffsetMs = Number.isFinite(timeOffsetMs) ? (timeOffsetMs ?? 0) : 0;
	const offsetSeconds = safeOffsetMs / 1000;
	const shiftedTime = currentTime - offsetSeconds;
	const safeTimelineDuration = finitePositiveSeconds(timelineDuration);
	const safeWebcamDuration = finitePositiveSeconds(webcamDuration);
	if (safeTimelineDuration !== null && safeWebcamDuration !== null) {
		const timelineStartTime = Math.max(0, offsetSeconds);
		const webcamStartTime = Math.max(0, -offsetSeconds);
		const timelineSpan = safeTimelineDuration - timelineStartTime;
		const webcamSpan = safeWebcamDuration - webcamStartTime;
		if (timelineSpan > 0 && webcamSpan > 0) {
			const driftSeconds = Math.abs(webcamSpan - timelineSpan);
			if (driftSeconds <= getWebcamDurationDriftToleranceSeconds(timelineSpan)) {
				const normalizedProgress = (currentTime - timelineStartTime) / timelineSpan;
				const normalizedTargetTime = webcamStartTime + normalizedProgress * webcamSpan;
				return clampMediaTimeToDuration(normalizedTargetTime, safeWebcamDuration);
			}
		}
	}

	return clampMediaTimeToDuration(shiftedTime, webcamDuration);
}

export const getWebcamPreviewTargetTimeSeconds = getWebcamMediaTargetTimeSeconds;

/**
 * Decides whether the webcam media element needs a corrective seek for the
 * current preview frame, while avoiding repeated seeks during active media seeks.
 */
export function shouldSeekWebcamMedia({
	desiredTime,
	isPlaying,
	isSeeking,
	previousTimelineTime,
	timelineTime,
	webcamCurrentTime,
}: {
	desiredTime: number;
	isPlaying: boolean;
	isSeeking: boolean;
	previousTimelineTime: number | null;
	timelineTime: number;
	webcamCurrentTime: number;
}): boolean {
	if (isSeeking) {
		return false;
	}

	const timelineJumped =
		previousTimelineTime === null || Math.abs(timelineTime - previousTimelineTime) > 0.25;
	const driftThreshold = isPlaying ? 0.35 : 0.01;

	return timelineJumped || Math.abs(webcamCurrentTime - desiredTime) > driftThreshold;
}

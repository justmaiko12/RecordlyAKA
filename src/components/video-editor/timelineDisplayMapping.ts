import {
	type ClipRegion,
	getClipSourceEndMs,
	mapSourceTimeToTimelineTime,
	mapTimelineTimeToSourceTime,
	sortClipRegions,
} from "./types";

/**
 * Magnet-ON display mapping.
 *
 * Spaces:
 * - SOURCE space: raw media time (annotation and camera regions, video element
 *   currentTime).
 * - TIMELINE space: clip-anchored time where each clip starts at its source
 *   startMs but runs at displayDuration = sourceDuration / speed (clip spans,
 *   zoom and audio regions, timelinePlayheadTime). Gaps left by deleted clips
 *   exist in both source and timeline space.
 * - DISPLAY space: timeline space with the inter-clip gaps collapsed, so clips
 *   pack contiguously from 0. This is what the timeline UI shows when the
 *   magnet is on.
 *
 * All functions are pure and treat an empty clip list as the identity mapping.
 */

export interface DisplayClipRegion extends ClipRegion {
	/** Original source-space span, carried for reverse mapping / debugging. */
	sourceStartMs: number;
	sourceEndMs: number;
}

interface DisplaySegment {
	clip: ClipRegion;
	timelineStartMs: number;
	timelineEndMs: number;
	displayStartMs: number;
	displayEndMs: number;
}

function buildDisplaySegments(clips: ClipRegion[]): DisplaySegment[] {
	const segments: DisplaySegment[] = [];
	let displayCursorMs = 0;

	for (const clip of sortClipRegions(clips)) {
		const displayDurationMs = Math.max(0, Math.round(clip.endMs) - Math.round(clip.startMs));
		segments.push({
			clip,
			timelineStartMs: Math.round(clip.startMs),
			timelineEndMs: Math.round(clip.startMs) + displayDurationMs,
			displayStartMs: displayCursorMs,
			displayEndMs: displayCursorMs + displayDurationMs,
		});
		displayCursorMs += displayDurationMs;
	}

	return segments;
}

/** Packs clips contiguously from 0, preserving order, duration and metadata. */
export function clipsToDisplay(clips: ClipRegion[]): DisplayClipRegion[] {
	return buildDisplaySegments(clips).map((segment) => ({
		...segment.clip,
		startMs: segment.displayStartMs,
		endMs: segment.displayEndMs,
		sourceStartMs: segment.clip.startMs,
		sourceEndMs: getClipSourceEndMs(segment.clip),
	}));
}

/** Total duration of the collapsed display (sum of clip display durations). */
export function getDisplayDurationMs(clips: ClipRegion[]): number {
	const segments = buildDisplaySegments(clips);
	return segments.length > 0 ? segments[segments.length - 1].displayEndMs : 0;
}

/**
 * Maps a TIMELINE-space time into DISPLAY space. Times inside a gap clamp to
 * the preceding clip boundary; times beyond the last clip clamp to the
 * display end.
 */
export function timelineMsToDisplay(timelineMs: number, clips: ClipRegion[]): number {
	const roundedMs = Math.round(timelineMs);
	const segments = buildDisplaySegments(clips);
	if (segments.length === 0) {
		return roundedMs;
	}

	for (const segment of segments) {
		if (roundedMs < segment.timelineStartMs) {
			// Inside the gap before this clip: clamp to the preceding boundary,
			// which is exactly this clip's display start.
			return segment.displayStartMs;
		}
		if (roundedMs <= segment.timelineEndMs) {
			return segment.displayStartMs + (roundedMs - segment.timelineStartMs);
		}
	}

	return segments[segments.length - 1].displayEndMs;
}

/**
 * Maps a DISPLAY-space time back into TIMELINE space. Times beyond the display
 * end clamp to the last clip's timeline end.
 */
export function displayMsToTimeline(displayMs: number, clips: ClipRegion[]): number {
	const roundedMs = Math.round(displayMs);
	const segments = buildDisplaySegments(clips);
	if (segments.length === 0) {
		return roundedMs;
	}

	for (const segment of segments) {
		// Strict inequality: a display time sitting exactly on a clip boundary
		// belongs to the NEXT clip's start (display space is contiguous), so the
		// round-trip of a clip start returns that clip's own timeline start.
		if (roundedMs < segment.displayEndMs) {
			const offsetMs = Math.max(0, roundedMs - segment.displayStartMs);
			return segment.timelineStartMs + offsetMs;
		}
	}

	return segments[segments.length - 1].timelineEndMs;
}

/** Maps a SOURCE-space time into DISPLAY space (speed-aware). */
export function msToDisplay(sourceMs: number, clips: ClipRegion[]): number {
	return timelineMsToDisplay(mapSourceTimeToTimelineTime(sourceMs, clips), clips);
}

/** Maps a DISPLAY-space time back into SOURCE space (speed-aware). */
export function msToSource(displayMs: number, clips: ClipRegion[]): number {
	return mapTimelineTimeToSourceTime(displayMsToTimeline(displayMs, clips), clips);
}

/** Maps a SOURCE-space region into DISPLAY space, preserving other fields. */
export function regionToDisplay<T extends { startMs: number; endMs: number }>(
	region: T,
	clips: ClipRegion[],
): T {
	return {
		...region,
		startMs: msToDisplay(region.startMs, clips),
		endMs: msToDisplay(region.endMs, clips),
	};
}

/** Maps a DISPLAY-space span back into SOURCE space. */
export function spanToSource(
	span: { start: number; end: number },
	clips: ClipRegion[],
): { start: number; end: number } {
	return {
		start: msToSource(span.start, clips),
		end: msToSource(span.end, clips),
	};
}

/** Maps a TIMELINE-space region into DISPLAY space, preserving other fields. */
export function timelineRegionToDisplay<T extends { startMs: number; endMs: number }>(
	region: T,
	clips: ClipRegion[],
): T {
	return {
		...region,
		startMs: timelineMsToDisplay(region.startMs, clips),
		endMs: timelineMsToDisplay(region.endMs, clips),
	};
}

/** Maps a DISPLAY-space span back into TIMELINE space. */
export function spanToTimeline(
	span: { start: number; end: number },
	clips: ClipRegion[],
): { start: number; end: number } {
	return {
		start: displayMsToTimeline(span.start, clips),
		end: displayMsToTimeline(span.end, clips),
	};
}

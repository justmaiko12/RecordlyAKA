import { isAnnotationTrackRowId, isAudioTrackRowId } from "./core/rows";

export const TIMELINE_AXIS_HEIGHT_PX = 32;
export const TIMELINE_ROW_MIN_HEIGHT_PX = 28;
// Per-row height the timeline panel asks for so every visible track renders
// comfortably. Matches the historical two-row default panel (32 + 2 * 64 = 160).
export const TIMELINE_COMFORTABLE_ROW_HEIGHT_PX = 64;

function normalizeRowCount(rowCount: number) {
	if (!Number.isFinite(rowCount)) {
		return 0;
	}

	return Math.max(0, Math.floor(rowCount));
}

export function getTimelineRowsMinHeightPx(rowCount: number) {
	return normalizeRowCount(rowCount) * TIMELINE_ROW_MIN_HEIGHT_PX;
}

export function getTimelineContentMinHeightPx(rowCount: number) {
	return TIMELINE_AXIS_HEIGHT_PX + getTimelineRowsMinHeightPx(rowCount);
}

export function getTimelinePreferredHeightPx(rowCount: number) {
	return (
		TIMELINE_AXIS_HEIGHT_PX + normalizeRowCount(rowCount) * TIMELINE_COMFORTABLE_ROW_HEIGHT_PX
	);
}

export interface CountTimelineRowsOptions {
	showCameraTrack: boolean;
	showSourceAudioTrack: boolean;
	sourceAudioTrackCount: number;
}

// Counts the rows the timeline canvas renders: clip + zoom (always), plus the
// camera row, source-audio rows, and one row per distinct annotation/audio track.
export function countTimelineRows(
	items: readonly { rowId: string }[],
	{ showCameraTrack, showSourceAudioTrack, sourceAudioTrackCount }: CountTimelineRowsOptions,
) {
	const annotationRowIds = new Set<string>();
	const audioRowIds = new Set<string>();
	for (const item of items) {
		if (isAnnotationTrackRowId(item.rowId)) annotationRowIds.add(item.rowId);
		if (isAudioTrackRowId(item.rowId)) audioRowIds.add(item.rowId);
	}
	const sourceAudioRows = showSourceAudioTrack ? Math.max(0, sourceAudioTrackCount) : 0;
	const cameraRows = showCameraTrack ? 1 : 0;
	return 2 + cameraRows + sourceAudioRows + annotationRowIds.size + audioRowIds.size;
}

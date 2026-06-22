import { isFillFrameAtMs, type FillFrameRegion } from "./fillFrameRegions";

export interface CursorVisibilityOptions {
	showCursor?: boolean;
	hideCursorInFillFrame?: boolean;
	fillFrameDefault?: boolean;
	fillFrameRegions?: FillFrameRegion[];
	timeMs: number;
}

export function shouldShowCursorAtMs({
	showCursor,
	hideCursorInFillFrame,
	fillFrameDefault,
	fillFrameRegions = [],
	timeMs,
}: CursorVisibilityOptions): boolean {
	if (showCursor !== true) {
		return false;
	}

	if (hideCursorInFillFrame !== true) {
		return true;
	}

	if (fillFrameDefault === true) {
		return false;
	}

	return !isFillFrameAtMs(fillFrameRegions, timeMs);
}


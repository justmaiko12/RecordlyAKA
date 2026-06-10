export type WebcamLayoutMode = "screen" | "camera-full";

export interface WebcamLayoutEvent {
	timeMs: number;
	mode: WebcamLayoutMode;
}

export interface WebcamLayoutRegion {
	id: string;
	startMs: number;
	endMs: number;
}

interface SizeLike {
	width: number;
	height: number;
}

export interface LetterboxRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Shared padding fraction used by both the preview and export renderers for camera-full layout. */
export const CAMERA_FULL_PADDING_FRACTION = 0.04;

function isValidEvent(event: WebcamLayoutEvent): boolean {
	return (
		Number.isFinite(event.timeMs) &&
		event.timeMs >= 0 &&
		(event.mode === "screen" || event.mode === "camera-full")
	);
}

/**
 * Converts recording-time toggle events into camera-full regions. Recording
 * starts in "screen" mode implicitly; an unterminated camera-full segment
 * runs to MAX_SAFE_INTEGER (renderers clamp to the video duration).
 */
export function eventsToWebcamLayoutRegions(events: WebcamLayoutEvent[]): WebcamLayoutRegion[] {
	const sorted = events.filter(isValidEvent).sort((a, b) => a.timeMs - b.timeMs);
	const regions: WebcamLayoutRegion[] = [];
	let openStartMs: number | null = null;

	for (const event of sorted) {
		if (event.mode === "camera-full") {
			if (openStartMs === null) {
				openStartMs = event.timeMs;
			}
		} else if (openStartMs !== null) {
			if (event.timeMs > openStartMs) {
				regions.push({
					id: `webcam-layout-${openStartMs}-${event.timeMs}`,
					startMs: openStartMs,
					endMs: event.timeMs,
				});
			}
			openStartMs = null;
		}
	}

	if (openStartMs !== null) {
		regions.push({
			id: `webcam-layout-${openStartMs}-end`,
			startMs: openStartMs,
			endMs: Number.MAX_SAFE_INTEGER,
		});
	}

	return regions;
}

export function isCameraFullAtMs(regions: WebcamLayoutRegion[], timeMs: number): boolean {
	return regions.some((region) => timeMs >= region.startMs && timeMs < region.endMs);
}

/** Largest content-aspect rect centered inside frame minus padding on all sides. */
export function getLetterboxRect(
	content: SizeLike,
	frame: SizeLike,
	paddingPx: number,
): LetterboxRect {
	const availableWidth = Math.max(0, frame.width - paddingPx * 2);
	const availableHeight = Math.max(0, frame.height - paddingPx * 2);
	if (
		!Number.isFinite(content.width) ||
		!Number.isFinite(content.height) ||
		content.width <= 0 ||
		content.height <= 0
	) {
		return { x: paddingPx, y: paddingPx, width: availableWidth, height: availableHeight };
	}

	const scale = Math.min(availableWidth / content.width, availableHeight / content.height);
	const width = content.width * scale;
	const height = content.height * scale;
	return {
		x: paddingPx + (availableWidth - width) / 2,
		y: paddingPx + (availableHeight - height) / 2,
		width,
		height,
	};
}

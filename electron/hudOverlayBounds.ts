export interface HudOverlayWorkArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

const NON_PASSTHROUGH_HUD_WIDTH_DIP = 860;
const NON_PASSTHROUGH_HUD_COMPACT_HEIGHT_DIP = 160;
const NON_PASSTHROUGH_HUD_EXPANDED_HEIGHT_DIP = 540;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function getHudOverlayWindowBounds(
	workArea: HudOverlayWorkArea,
	mousePassthroughSupported: boolean,
	fallbackExpanded = false,
	bottomSafeAreaDip = 0,
): HudOverlayWorkArea {
	if (mousePassthroughSupported) {
		return { ...workArea };
	}

	const width = Math.min(workArea.width, NON_PASSTHROUGH_HUD_WIDTH_DIP);
	const height = Math.min(
		workArea.height,
		fallbackExpanded
			? NON_PASSTHROUGH_HUD_EXPANDED_HEIGHT_DIP
			: NON_PASSTHROUGH_HUD_COMPACT_HEIGHT_DIP,
	);

	const bottomSafeArea = clamp(bottomSafeAreaDip, 0, Math.max(0, workArea.height - height));

	return {
		x: Math.round(workArea.x + (workArea.width - width) / 2),
		y: Math.round(workArea.y + workArea.height - height - bottomSafeArea),
		width,
		height,
	};
}
export function resizeHudOverlayFallbackBounds(
	workArea: HudOverlayWorkArea,
	currentBounds: HudOverlayWorkArea,
	fallbackExpanded: boolean,
	bottomSafeAreaDip = 0,
): HudOverlayWorkArea {
	const nextBounds = getHudOverlayWindowBounds(
		workArea,
		false,
		fallbackExpanded,
		bottomSafeAreaDip,
	);
	const maxX = workArea.x + workArea.width - nextBounds.width;
	const maxY =
		workArea.y +
		workArea.height -
		nextBounds.height -
		clamp(bottomSafeAreaDip, 0, Math.max(0, workArea.height - nextBounds.height));

	return {
		...nextBounds,
		x: clamp(currentBounds.x, workArea.x, maxX),
		y: clamp(currentBounds.y + currentBounds.height - nextBounds.height, workArea.y, maxY),
	};
}

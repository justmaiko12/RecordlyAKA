export const PREVIEW_READY_FALLBACK_TIMEOUT_MS = 1_200;

const HAVE_CURRENT_DATA_READY_STATE = 2;

export type PreviewVideoReadinessInput = Pick<
	HTMLVideoElement,
	"readyState" | "videoHeight" | "videoWidth"
>;

export type PreviewVideoReadiness = {
	hasData: boolean;
	hasDimensions: boolean;
	ready: boolean;
	usedFallback: boolean;
};

export function hasPreviewVideoDimensions(video: PreviewVideoReadinessInput): boolean {
	return video.videoWidth > 0 && video.videoHeight > 0;
}

export function hasPreviewVideoFrameData(video: PreviewVideoReadinessInput): boolean {
	return video.readyState >= HAVE_CURRENT_DATA_READY_STATE;
}

export function resolvePreviewVideoReadiness(
	video: PreviewVideoReadinessInput,
	elapsedMs: number,
): PreviewVideoReadiness {
	const hasDimensions = hasPreviewVideoDimensions(video);
	const hasData = hasPreviewVideoFrameData(video);
	const usedFallback =
		hasDimensions && !hasData && elapsedMs >= PREVIEW_READY_FALLBACK_TIMEOUT_MS;

	return {
		hasData,
		hasDimensions,
		ready: hasDimensions && (hasData || usedFallback),
		usedFallback,
	};
}

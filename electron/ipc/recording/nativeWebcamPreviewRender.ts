// Keep live preview on accepted proof snapshots without flooding the renderer.
// 33ms is roughly 30fps, matching the default webcam capture cadence while still
// bounding Electron image decode work to one visible frame per display tick.
export const NATIVE_WEBCAM_PREVIEW_RENDER_EVENT_INTERVAL_MS = 33;

export function createNativeWebcamPreviewRendererUpdateGate({
	minIntervalMs = NATIVE_WEBCAM_PREVIEW_RENDER_EVENT_INTERVAL_MS,
	nowMs = () => Date.now(),
}: {
	minIntervalMs?: number;
	nowMs?: () => number;
} = {}) {
	let lastEmittedAtMs = 0;
	let lastEmittedSequence = 0;

	return function shouldEmitNativeWebcamPreviewFrame(sequence: number): boolean {
		if (!Number.isFinite(sequence) || sequence <= 0 || sequence <= lastEmittedSequence) {
			return false;
		}

		const now = nowMs();
		const elapsedMs = Number.isFinite(now) ? now - lastEmittedAtMs : minIntervalMs;
		const shouldEmit =
			lastEmittedSequence === 0 ||
			!Number.isFinite(minIntervalMs) ||
			minIntervalMs <= 0 ||
			elapsedMs >= minIntervalMs;

		if (!shouldEmit) {
			return false;
		}

		lastEmittedSequence = sequence;
		lastEmittedAtMs = Number.isFinite(now) ? now : lastEmittedAtMs;
		return true;
	};
}

export const NATIVE_WEBCAM_PREVIEW_STALE_MS = 2_000;
export const NATIVE_WEBCAM_PREVIEW_PROBE_INTERVAL_MS = 1_000;
export const NATIVE_WEBCAM_PREVIEW_PROBE_TIMEOUT_MS = 2_000;
export const NATIVE_WEBCAM_PREVIEW_MAX_IMAGE_LOAD_MS = 120;

export type NativeWebcamPreviewEvent = {
	active: boolean;
	status: "starting" | "frame" | "stopped";
	url?: string | null;
	streamUrl?: string | null;
	path?: string | null;
	updatedAt?: number;
	details?: Record<string, unknown>;
};

export type NativeWebcamPreviewViewState = {
	active: boolean;
	url: string | null;
	streamUrl: string | null;
	lastFrameAtMs: number | null;
	stale: boolean;
};

export type NativeWebcamPreviewImagePumpState = {
	activeUrl: string | null;
	pendingUrl: string | null;
	loadInFlight: boolean;
	lastAssignedAtMs: number | null;
};

export type NativeWebcamPreviewImageAssignment =
	| { action: "assign"; url: string }
	| { action: "wait"; delayMs: number | null };

export type NativeWebcamPreviewVisibleCadence = {
	loadTimes: number[];
	visibleFps: number | null;
	windowMs: number;
	lowCadence: boolean;
};

export function createInitialNativeWebcamPreviewState(): NativeWebcamPreviewViewState {
	return {
		active: false,
		url: null,
		streamUrl: null,
		lastFrameAtMs: null,
		stale: false,
	};
}

export function createInitialNativeWebcamPreviewImagePumpState(): NativeWebcamPreviewImagePumpState {
	return {
		activeUrl: null,
		pendingUrl: null,
		loadInFlight: false,
		lastAssignedAtMs: null,
	};
}

export function isNativeWebcamPreviewFresh(
	nowMs: number,
	lastFrameAtMs: number | null,
	staleAfterMs = NATIVE_WEBCAM_PREVIEW_STALE_MS,
): boolean {
	if (
		!Number.isFinite(nowMs) ||
		!Number.isFinite(staleAfterMs) ||
		typeof lastFrameAtMs !== "number" ||
		!Number.isFinite(lastFrameAtMs)
	) {
		return false;
	}
	return nowMs - lastFrameAtMs < staleAfterMs;
}

export function reduceNativeWebcamPreviewEvent(
	previous: NativeWebcamPreviewViewState,
	event: NativeWebcamPreviewEvent,
	nowMs: number,
): NativeWebcamPreviewViewState {
	if (!event.active || event.status === "stopped") {
		return createInitialNativeWebcamPreviewState();
	}

	if (event.status === "starting") {
		return {
			active: true,
			url: null,
			streamUrl: event.streamUrl ?? null,
			lastFrameAtMs: null,
			stale: false,
		};
	}

	if (event.status !== "frame") {
		return previous;
	}

	const frameAtMs = typeof event.updatedAt === "number" ? event.updatedAt : nowMs;
	const streamUrl = event.streamUrl ?? previous.streamUrl ?? null;
	const latestFrameUrl = streamUrl ? (event.url ?? previous.url ?? null) : null;
	return {
		active: true,
		url: latestFrameUrl,
		streamUrl,
		lastFrameAtMs: streamUrl ? frameAtMs : null,
		stale: false,
	};
}

export function expireNativeWebcamPreviewFrame(
	previous: NativeWebcamPreviewViewState,
	nowMs: number,
	staleAfterMs = NATIVE_WEBCAM_PREVIEW_STALE_MS,
): NativeWebcamPreviewViewState {
	if (
		!previous.active ||
		(!previous.url && !previous.streamUrl) ||
		isNativeWebcamPreviewFresh(nowMs, previous.lastFrameAtMs, staleAfterMs)
	) {
		return previous;
	}

	return {
		...previous,
		url: null,
		streamUrl: null,
		stale: true,
	};
}

export function selectNativeWebcamPreviewDisplayUrl(
	state: NativeWebcamPreviewViewState,
): string | null {
	if (!state.active || state.stale || state.lastFrameAtMs === null) {
		return null;
	}

	// The visible preview should be the latest accepted proof snapshot. That
	// avoids MJPEG decoder queues showing stale camera frames while the native
	// writer is still healthy.
	return state.url;
}

export function selectNativeWebcamPreviewStreamDisplayUrl(
	state: NativeWebcamPreviewViewState,
): string | null {
	if (!state.active || state.stale || state.lastFrameAtMs === null || !state.url) {
		return null;
	}

	// Teleprompter needs a low-latency continuous surface. Only expose the stream
	// after accepted proof frames exist, so the visible source is still backed by
	// the native writer path rather than an unproven camera feed.
	return state.streamUrl;
}

export function queueNativeWebcamPreviewImageFrame(
	state: NativeWebcamPreviewImagePumpState,
	url: string,
): NativeWebcamPreviewImagePumpState {
	return {
		...state,
		pendingUrl: url,
	};
}

export function selectNativeWebcamPreviewImageAssignment(
	state: NativeWebcamPreviewImagePumpState,
	nowMs: number,
	minSwapMs: number,
	maxInFlightMs = Number.POSITIVE_INFINITY,
): NativeWebcamPreviewImageAssignment {
	if (!state.pendingUrl) {
		return { action: "wait", delayMs: null };
	}

	const lastAssignedAtMs = state.lastAssignedAtMs;
	if (state.loadInFlight) {
		const canPreemptSlowLoad =
			state.activeUrl !== state.pendingUrl &&
			typeof lastAssignedAtMs === "number" &&
			Number.isFinite(lastAssignedAtMs) &&
			Number.isFinite(nowMs) &&
			Number.isFinite(maxInFlightMs) &&
			maxInFlightMs >= 0 &&
			nowMs - lastAssignedAtMs >= maxInFlightMs;
		if (!canPreemptSlowLoad) {
			return { action: "wait", delayMs: null };
		}
	}

	if (
		typeof lastAssignedAtMs === "number" &&
		Number.isFinite(lastAssignedAtMs) &&
		Number.isFinite(nowMs) &&
		Number.isFinite(minSwapMs)
	) {
		const delayMs = Math.max(0, minSwapMs - (nowMs - lastAssignedAtMs));
		if (delayMs > 0) {
			return { action: "wait", delayMs };
		}
	}

	return { action: "assign", url: state.pendingUrl };
}

export function commitNativeWebcamPreviewImageAssignment(
	state: NativeWebcamPreviewImagePumpState,
	url: string,
	nowMs: number,
): NativeWebcamPreviewImagePumpState {
	return {
		...state,
		activeUrl: url,
		pendingUrl: state.pendingUrl === url ? null : state.pendingUrl,
		loadInFlight: true,
		lastAssignedAtMs: nowMs,
	};
}

export function completeNativeWebcamPreviewImageLoad(
	state: NativeWebcamPreviewImagePumpState,
	loadedUrl: string,
): { state: NativeWebcamPreviewImagePumpState; accepted: boolean } {
	const accepted = loadedUrl === state.activeUrl;
	return {
		accepted,
		state: accepted
			? {
					...state,
					loadInFlight: false,
				}
			: state,
	};
}

export function blankNativeWebcamPreviewImageDisplay(
	state: NativeWebcamPreviewImagePumpState,
): NativeWebcamPreviewImagePumpState {
	return {
		...state,
		activeUrl: null,
		loadInFlight: false,
	};
}

export function failNativeWebcamPreviewImageLoad(
	state: NativeWebcamPreviewImagePumpState,
): NativeWebcamPreviewImagePumpState {
	return {
		...state,
		loadInFlight: false,
	};
}

export function updateNativeWebcamPreviewVisibleCadence({
	previousLoadTimes,
	nowMs,
	recordingActive,
	windowMs,
	minFps,
	minMeasuredWindowMs = windowMs / 2,
}: {
	previousLoadTimes: number[];
	nowMs: number;
	recordingActive: boolean;
	windowMs: number;
	minFps: number;
	minMeasuredWindowMs?: number;
}): NativeWebcamPreviewVisibleCadence {
	const boundedWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;
	const loadTimes = [...previousLoadTimes, nowMs]
		.filter((loadAtMs) => Number.isFinite(loadAtMs))
		.filter((loadAtMs) => boundedWindowMs <= 0 || nowMs - loadAtMs <= boundedWindowMs);
	const measuredWindowMs = loadTimes.length >= 2 ? nowMs - loadTimes[0] : 0;
	const visibleFps =
		measuredWindowMs > 0 ? ((loadTimes.length - 1) / measuredWindowMs) * 1_000 : null;
	const lowCadence =
		recordingActive &&
		visibleFps !== null &&
		Number.isFinite(minFps) &&
		Number.isFinite(minMeasuredWindowMs) &&
		measuredWindowMs >= minMeasuredWindowMs &&
		visibleFps < minFps;

	return {
		loadTimes,
		visibleFps,
		windowMs: measuredWindowMs,
		lowCadence,
	};
}

export function hasNativeWebcamPreviewRenderStateChanged(
	previous: NativeWebcamPreviewViewState,
	next: NativeWebcamPreviewViewState,
): boolean {
	return (
		previous.active !== next.active ||
		previous.stale !== next.stale ||
		selectNativeWebcamPreviewDisplayUrl(previous) !== selectNativeWebcamPreviewDisplayUrl(next)
	);
}

export function hasNativeWebcamPreviewMountStateChanged(
	previous: NativeWebcamPreviewViewState,
	next: NativeWebcamPreviewViewState,
): boolean {
	return (
		previous.active !== next.active ||
		previous.stale !== next.stale ||
		Boolean(selectNativeWebcamPreviewDisplayUrl(previous)) !==
			Boolean(selectNativeWebcamPreviewDisplayUrl(next))
	);
}

export function getNativeWebcamPreviewExpiryDelay(
	state: NativeWebcamPreviewViewState,
	nowMs: number,
	staleAfterMs = NATIVE_WEBCAM_PREVIEW_STALE_MS,
): number | null {
	if (!state.active || (!state.url && !state.streamUrl) || state.lastFrameAtMs === null) {
		return null;
	}

	const ageMs = nowMs - state.lastFrameAtMs;
	return Math.max(0, staleAfterMs - ageMs);
}

export function isNativeWebcamPreviewVisibleLoadStale({
	nowMs,
	previewUrl,
	visibleStartedAtMs,
	lastVisibleLoadAtMs,
	timeoutMs = NATIVE_WEBCAM_PREVIEW_PROBE_TIMEOUT_MS,
}: {
	nowMs: number;
	previewUrl?: string | null;
	visibleStartedAtMs: number | null;
	lastVisibleLoadAtMs: number | null;
	timeoutMs?: number;
}): boolean {
	if (!previewUrl || !Number.isFinite(nowMs) || !Number.isFinite(timeoutMs)) {
		return false;
	}

	const visibleEvidenceAtMs = lastVisibleLoadAtMs ?? visibleStartedAtMs;
	if (typeof visibleEvidenceAtMs !== "number" || !Number.isFinite(visibleEvidenceAtMs)) {
		return false;
	}

	return nowMs - visibleEvidenceAtMs >= timeoutMs;
}

export function shouldRequestNativeWebcamPreviewProbe({
	nowMs,
	lastProbeRequestedAtMs,
	snapshotUrl,
	intervalMs = NATIVE_WEBCAM_PREVIEW_PROBE_INTERVAL_MS,
}: {
	nowMs: number;
	lastProbeRequestedAtMs: number | null;
	snapshotUrl?: string | null;
	intervalMs?: number;
}): boolean {
	if (!snapshotUrl || !Number.isFinite(nowMs) || !Number.isFinite(intervalMs)) {
		return false;
	}
	if (lastProbeRequestedAtMs === null || !Number.isFinite(lastProbeRequestedAtMs)) {
		return true;
	}
	return nowMs - lastProbeRequestedAtMs >= intervalMs;
}

export function buildNativeWebcamPreviewProbeUrl(snapshotUrl: string, nowMs: number): string {
	const separator = snapshotUrl.includes("?") ? "&" : "?";
	return `${snapshotUrl}${separator}probe=${encodeURIComponent(String(nowMs))}`;
}

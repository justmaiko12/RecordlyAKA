import {
	type PointerEvent,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	blankNativeWebcamPreviewImageDisplay,
	commitNativeWebcamPreviewImageAssignment,
	completeNativeWebcamPreviewImageLoad,
	createInitialNativeWebcamPreviewState,
	createInitialNativeWebcamPreviewImagePumpState,
	expireNativeWebcamPreviewFrame,
	failNativeWebcamPreviewImageLoad,
	isNativeWebcamPreviewVisibleLoadStale,
	NATIVE_WEBCAM_PREVIEW_MAX_IMAGE_LOAD_MS,
	queueNativeWebcamPreviewImageFrame,
	reduceNativeWebcamPreviewEvent,
	selectNativeWebcamPreviewImageAssignment,
	selectNativeWebcamPreviewDisplayUrl,
} from "@/lib/nativeWebcamPreview";
import {
	acquireWebcamSession,
	DEFAULT_WEBCAM_FRAME_RATE,
	DEFAULT_WEBCAM_QUALITY_MODE,
	getWebcamQualityProfile,
	type WebcamFrameRate,
	type WebcamQualityMode,
	type WebcamSessionHandle,
} from "@/lib/webcamSession";

const WEBCAM_PREVIEW_DRAG_THRESHOLD = 6;
const DEFAULT_WEBCAM_PREVIEW_OFFSET = { x: 0, y: 0 };
const NATIVE_PREVIEW_MIN_IMAGE_SWAP_MS = 33;
const EXPECTED_NATIVE_PREVIEW_STOP_REASONS = new Set([
	"recording-start",
	"renderer-stop",
	"replaced",
]);

export function shouldShowRecordingWebcamPreview(_options: {
	webcamEnabled: boolean;
	hudCompact: boolean;
	showFloatingWebcamPreview: boolean;
	hudOverlayMousePassthroughSupported: boolean | null;
}) {
	return false;
}

export function shouldAcquireBrowserWebcamPreview({
	webcamEnabled,
	browserPreviewAvailable = true,
	nativePreviewPreferred = false,
	showRecordingWebcamPreview,
	showWebcamControls,
	webcamPopoverOpen,
}: {
	webcamEnabled: boolean;
	browserPreviewAvailable?: boolean;
	nativePreviewPreferred?: boolean;
	showRecordingWebcamPreview: boolean;
	showWebcamControls: boolean;
	webcamPopoverOpen: boolean;
}) {
	return (
		webcamEnabled &&
		browserPreviewAvailable &&
		!nativePreviewPreferred &&
		(showRecordingWebcamPreview || (showWebcamControls && webcamPopoverOpen))
	);
}

export function shouldAcquireNativeWebcamPreview({
	webcamEnabled,
	nativePreviewPreferred,
	showRecordingWebcamPreview,
	showWebcamControls,
	webcamPopoverOpen,
}: {
	webcamEnabled: boolean;
	nativePreviewPreferred: boolean;
	showRecordingWebcamPreview: boolean;
	showWebcamControls: boolean;
	webcamPopoverOpen: boolean;
}) {
	return (
		webcamEnabled &&
		nativePreviewPreferred &&
		(showRecordingWebcamPreview || (showWebcamControls && webcamPopoverOpen))
	);
}

export function hasNativeWebcamPreviewIssue({
	nativePreviewPreferred,
	nativePreviewStartIssue,
	nativePreviewImageIssue,
}: {
	nativePreviewPreferred: boolean;
	nativePreviewStartIssue?: string | null;
	nativePreviewImageIssue: boolean;
}) {
	return (
		nativePreviewPreferred &&
		(nativePreviewImageIssue ||
			(typeof nativePreviewStartIssue === "string" && nativePreviewStartIssue.length > 0))
	);
}

export function getNativeWebcamPreviewStopReason(recordingActive: boolean) {
	return recordingActive ? "recording-start" : "renderer-stop";
}

export function selectRenderableNativePreviewUrl({
	assignedUrl,
	failedUrl,
}: {
	assignedUrl: string | null;
	failedUrl: string | null;
}) {
	return assignedUrl && assignedUrl !== failedUrl ? assignedUrl : null;
}

export function useWebcamPreviewOverlay({
	webcamEnabled,
	webcamDeviceId,
	webcamFrameRate = DEFAULT_WEBCAM_FRAME_RATE,
	webcamQualityMode = DEFAULT_WEBCAM_QUALITY_MODE,
	browserPreviewAvailable = true,
	nativePreviewPreferred = false,
	nativePreviewDeviceId,
	nativePreviewLabel,
	showWebcamControls,
	webcamPopoverOpen,
	hudOverlayMousePassthroughSupported,
	hudCompact = false,
	recordingActive = false,
}: {
	webcamEnabled: boolean;
	webcamDeviceId?: string;
	webcamFrameRate?: WebcamFrameRate;
	webcamQualityMode?: WebcamQualityMode;
	browserPreviewAvailable?: boolean;
	nativePreviewPreferred?: boolean;
	nativePreviewDeviceId?: string | null;
	nativePreviewLabel?: string | null;
	showWebcamControls: boolean;
	webcamPopoverOpen: boolean;
	hudOverlayMousePassthroughSupported: boolean | null;
	/**
	 * While recording/finalizing the HUD window shrinks to a compact strip
	 * (getHudOverlayBounds passes !hudOverlayRecordingActive), so the 288px
	 * floating preview would be clipped to a sliver — hide it instead.
	 */
	hudCompact?: boolean;
	recordingActive?: boolean;
}) {
	const [showFloatingWebcamPreview, setShowFloatingWebcamPreview] = useState(false);
	const [webcamPreviewOffset, setWebcamPreviewOffset] = useState(DEFAULT_WEBCAM_PREVIEW_OFFSET);
	const [nativePreviewState, setNativePreviewState] = useState(
		createInitialNativeWebcamPreviewState,
	);
	const [failedNativePreviewUrl, setFailedNativePreviewUrl] = useState<string | null>(null);
	const [nativePreviewStartIssue, setNativePreviewStartIssue] = useState<string | null>(null);
	const [assignedNativePreviewUrl, setAssignedNativePreviewUrl] = useState<string | null>(null);
	const shouldStreamNativePreviewRef = useRef(false);
	const recordingActiveRef = useRef(recordingActive);
	const nativePreviewPumpStateRef = useRef(createInitialNativeWebcamPreviewImagePumpState());
	const nativePreviewSwapTimerRef = useRef<number | null>(null);
	const activeNativeVisiblePreviewUrlRef = useRef<string | null>(null);
	const nativeVisiblePreviewStartedAtRef = useRef<number | null>(null);
	const lastNativeVisiblePreviewLoadAtRef = useRef<number | null>(null);
	const webcamPreviewOffsetRef = useRef(DEFAULT_WEBCAM_PREVIEW_OFFSET);
	const webcamPreviewRef = useRef<HTMLVideoElement | null>(null);
	const recordingWebcamPreviewRef = useRef<HTMLVideoElement | null>(null);
	const recordingWebcamPreviewContainerRef = useRef<HTMLDivElement | null>(null);
	const previewStreamRef = useRef<MediaStream | null>(null);
	const previewDragMoveRafRef = useRef<number | null>(null);
	const previewDragPendingPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
	const webcamPreviewDragStartRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		originX: number;
		originY: number;
		initialLeft: number;
		initialTop: number;
		previewWidth: number;
		previewHeight: number;
		dragging: boolean;
	} | null>(null);
	const isWebcamPreviewDraggingRef = useRef(false);
	const showRecordingWebcamPreview = shouldShowRecordingWebcamPreview({
		webcamEnabled,
		hudCompact,
		showFloatingWebcamPreview,
		hudOverlayMousePassthroughSupported,
	});
	const shouldStreamWebcamPreview = shouldAcquireBrowserWebcamPreview({
		webcamEnabled,
		browserPreviewAvailable,
		nativePreviewPreferred,
		showRecordingWebcamPreview,
		showWebcamControls,
		webcamPopoverOpen,
	});
	const shouldStreamNativePreview = shouldAcquireNativeWebcamPreview({
		webcamEnabled,
		nativePreviewPreferred,
		showRecordingWebcamPreview,
		showWebcamControls,
		webcamPopoverOpen,
	});

	const clearNativePreviewSwapTimer = useCallback(() => {
		if (nativePreviewSwapTimerRef.current !== null) {
			window.clearTimeout(nativePreviewSwapTimerRef.current);
			nativePreviewSwapTimerRef.current = null;
		}
	}, []);

	const resetNativePreviewImagePump = useCallback(() => {
		clearNativePreviewSwapTimer();
		nativePreviewPumpStateRef.current = createInitialNativeWebcamPreviewImagePumpState();
		activeNativeVisiblePreviewUrlRef.current = null;
		nativeVisiblePreviewStartedAtRef.current = null;
		lastNativeVisiblePreviewLoadAtRef.current = null;
		setAssignedNativePreviewUrl(null);
	}, [clearNativePreviewSwapTimer]);

	const pumpNativePreviewImage = useCallback(() => {
		if (nativePreviewSwapTimerRef.current !== null) {
			return;
		}

		const assignment = selectNativeWebcamPreviewImageAssignment(
			nativePreviewPumpStateRef.current,
			Date.now(),
			NATIVE_PREVIEW_MIN_IMAGE_SWAP_MS,
			NATIVE_WEBCAM_PREVIEW_MAX_IMAGE_LOAD_MS,
		);
		if (assignment.action === "wait") {
			if (assignment.delayMs === null || assignment.delayMs <= 0) {
				return;
			}
			nativePreviewSwapTimerRef.current = window.setTimeout(() => {
				nativePreviewSwapTimerRef.current = null;
				pumpNativePreviewImage();
			}, assignment.delayMs);
			return;
		}

		nativePreviewPumpStateRef.current = commitNativeWebcamPreviewImageAssignment(
			nativePreviewPumpStateRef.current,
			assignment.url,
			Date.now(),
		);
		activeNativeVisiblePreviewUrlRef.current = assignment.url;
		if (nativeVisiblePreviewStartedAtRef.current === null) {
			nativeVisiblePreviewStartedAtRef.current = Date.now();
		}
		setAssignedNativePreviewUrl(assignment.url);
	}, []);

	const reportNativePreviewRendererIssue = useCallback(
		(issue: string, previewUrl?: string | null, nowMs = Date.now()) => {
			void window.electronAPI
				?.reportNativeWebcamPreviewRendererIssue?.({
					surface: recordingActiveRef.current
						? "hud-recording-preview"
						: "webcam-popover-preview",
					issue,
					previewUrl: previewUrl ?? null,
					visibleStartedAtMs: nativeVisiblePreviewStartedAtRef.current,
					lastVisibleLoadAtMs: lastNativeVisiblePreviewLoadAtRef.current,
					nowMs,
					recordingActive: recordingActiveRef.current,
				})
				.catch((error) => {
					console.warn("Failed to report native webcam renderer preview issue:", error);
				});
		},
		[],
	);

	useEffect(() => {
		return () => {
			clearNativePreviewSwapTimer();
		};
	}, [clearNativePreviewSwapTimer]);

	useEffect(() => {
		recordingActiveRef.current = recordingActive;
	}, [recordingActive]);

	useEffect(() => {
		shouldStreamNativePreviewRef.current = shouldStreamNativePreview;
		if (!shouldStreamNativePreview) {
			setNativePreviewStartIssue(null);
			setFailedNativePreviewUrl(null);
			resetNativePreviewImagePump();
		}
	}, [resetNativePreviewImagePump, shouldStreamNativePreview]);

	useEffect(() => {
		if (!webcamEnabled) {
			webcamPreviewOffsetRef.current = DEFAULT_WEBCAM_PREVIEW_OFFSET;
			setWebcamPreviewOffset(DEFAULT_WEBCAM_PREVIEW_OFFSET);
			if (recordingWebcamPreviewContainerRef.current) {
				recordingWebcamPreviewContainerRef.current.style.transform = "translate(0px, 0px)";
			}
			webcamPreviewDragStartRef.current = null;
			isWebcamPreviewDraggingRef.current = false;
			setShowFloatingWebcamPreview(false);
		}
	}, [webcamEnabled]);

	useEffect(() => {
		const unsubscribe = window.electronAPI?.onNativeWebcamPreview?.((event) => {
			if (event.active && event.status === "frame") {
				setNativePreviewStartIssue(null);
			}
			if (
				!event.active &&
				event.status === "stopped" &&
				shouldStreamNativePreviewRef.current
			) {
				const reason =
					typeof event.details?.reason === "string" ? event.details.reason : null;
				if (!reason || !EXPECTED_NATIVE_PREVIEW_STOP_REASONS.has(reason)) {
					setNativePreviewStartIssue(reason ?? "native-preview-stopped");
				}
			}
			setNativePreviewState((previous) =>
				reduceNativeWebcamPreviewEvent(previous, event, Date.now()),
			);
		});
		return unsubscribe;
	}, []);

	useEffect(() => {
		const interval = window.setInterval(() => {
			const now = Date.now();
			setNativePreviewState((previous) => expireNativeWebcamPreviewFrame(previous, now));
			const visiblePreviewUrl = activeNativeVisiblePreviewUrlRef.current;
			if (
				isNativeWebcamPreviewVisibleLoadStale({
					nowMs: now,
					previewUrl: visiblePreviewUrl,
					visibleStartedAtMs: nativeVisiblePreviewStartedAtRef.current,
					lastVisibleLoadAtMs: lastNativeVisiblePreviewLoadAtRef.current,
				})
			) {
				reportNativePreviewRendererIssue("visible-load-stale", visiblePreviewUrl, now);
				setFailedNativePreviewUrl(visiblePreviewUrl);
				nativePreviewPumpStateRef.current = blankNativeWebcamPreviewImageDisplay(
					nativePreviewPumpStateRef.current,
				);
				activeNativeVisiblePreviewUrlRef.current = null;
				setAssignedNativePreviewUrl(null);
				pumpNativePreviewImage();
			}
		}, 250);

		return () => window.clearInterval(interval);
	}, [pumpNativePreviewImage, reportNativePreviewRendererIssue]);

	const handleNativePreviewImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
		const loadedUrl = event.currentTarget.currentSrc || event.currentTarget.src;
		const result = completeNativeWebcamPreviewImageLoad(
			nativePreviewPumpStateRef.current,
			loadedUrl,
		);
		nativePreviewPumpStateRef.current = result.state;
		if (!loadedUrl || !result.accepted) {
			pumpNativePreviewImage();
			return;
		}
		lastNativeVisiblePreviewLoadAtRef.current = Date.now();
		setFailedNativePreviewUrl((current) => (current === loadedUrl ? null : current));
		pumpNativePreviewImage();
	}, [pumpNativePreviewImage]);

	const handleNativePreviewImageError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
		const failedUrl = event.currentTarget.currentSrc || event.currentTarget.src;
		if (failedUrl) {
			reportNativePreviewRendererIssue("visible-image-error", failedUrl);
			setFailedNativePreviewUrl(failedUrl);
		}
		nativePreviewPumpStateRef.current = failNativeWebcamPreviewImageLoad(
			nativePreviewPumpStateRef.current,
		);
		setAssignedNativePreviewUrl(null);
		pumpNativePreviewImage();
	}, [pumpNativePreviewImage, reportNativePreviewRendererIssue]);

	const handleWebcamPreviewPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) {
			return;
		}

		const previewRect = event.currentTarget.getBoundingClientRect();

		event.preventDefault();
		window.electronAPI?.hudOverlaySetIgnoreMouse?.(false);
		webcamPreviewDragStartRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			originX: webcamPreviewOffsetRef.current.x,
			originY: webcamPreviewOffsetRef.current.y,
			initialLeft: previewRect.left,
			initialTop: previewRect.top,
			previewWidth: previewRect.width,
			previewHeight: previewRect.height,
			dragging: false,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	}, []);

	const handleWebcamPreviewPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
		const dragState = webcamPreviewDragStartRef.current;
		if (!dragState || dragState.pointerId !== event.pointerId) {
			return;
		}

		const deltaX = event.clientX - dragState.startX;
		const deltaY = event.clientY - dragState.startY;

		if (!dragState.dragging && Math.hypot(deltaX, deltaY) < WEBCAM_PREVIEW_DRAG_THRESHOLD) {
			return;
		}

		if (!dragState.dragging) {
			dragState.dragging = true;
			isWebcamPreviewDraggingRef.current = true;
		}

		previewDragPendingPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
		if (previewDragMoveRafRef.current !== null) {
			return;
		}

		previewDragMoveRafRef.current = requestAnimationFrame(() => {
			previewDragMoveRafRef.current = null;
			const latestDragState = webcamPreviewDragStartRef.current;
			const pointer = previewDragPendingPointerRef.current;
			if (!latestDragState || !pointer) {
				return;
			}

			const latestDeltaX = pointer.clientX - latestDragState.startX;
			const latestDeltaY = pointer.clientY - latestDragState.startY;
			const viewportWidth = Math.max(window.innerWidth, window.screen?.width ?? 0);
			const viewportHeight = Math.max(window.innerHeight, window.screen?.height ?? 0);
			const unclampedLeft = latestDragState.initialLeft + latestDeltaX;
			const unclampedTop = latestDragState.initialTop + latestDeltaY;
			const clampedLeft = Math.min(
				Math.max(0, unclampedLeft),
				Math.max(0, viewportWidth - latestDragState.previewWidth),
			);
			const clampedTop = Math.min(
				Math.max(0, unclampedTop),
				Math.max(0, viewportHeight - latestDragState.previewHeight),
			);

			const nextOffset = {
				x: latestDragState.originX + (clampedLeft - latestDragState.initialLeft),
				y: latestDragState.originY + (clampedTop - latestDragState.initialTop),
			};
			webcamPreviewOffsetRef.current = nextOffset;
			if (recordingWebcamPreviewContainerRef.current) {
				recordingWebcamPreviewContainerRef.current.style.transform = `translate(${nextOffset.x}px, ${nextOffset.y}px)`;
			}
		});
	}, []);

	const handleWebcamPreviewPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
		const dragState = webcamPreviewDragStartRef.current;
		if (!dragState || dragState.pointerId !== event.pointerId) {
			return;
		}
		if (previewDragMoveRafRef.current !== null) {
			cancelAnimationFrame(previewDragMoveRafRef.current);
			previewDragMoveRafRef.current = null;
		}
		previewDragPendingPointerRef.current = null;

		const wasDragging = dragState.dragging;
		webcamPreviewDragStartRef.current = null;
		isWebcamPreviewDraggingRef.current = false;
		setWebcamPreviewOffset({ ...webcamPreviewOffsetRef.current });
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		if (wasDragging) {
			window.electronAPI?.hudOverlaySetIgnoreMouse?.(true);
		}
	}, []);

	const attachPreviewStreamToNode = useCallback((videoElement: HTMLVideoElement | null) => {
		const previewStream = previewStreamRef.current;
		if (!videoElement || !previewStream || videoElement.srcObject === previewStream) {
			return;
		}

		videoElement.srcObject = previewStream;
		const playPromise = videoElement.play();
		if (playPromise) {
			playPromise.catch(() => {
				// Ignore autoplay interruptions while the preview element mounts.
			});
		}
	}, []);

	const setWebcamPreviewNode = useCallback(
		(node: HTMLVideoElement | null) => {
			webcamPreviewRef.current = node;
			attachPreviewStreamToNode(node);
		},
		[attachPreviewStreamToNode],
	);

	const setRecordingWebcamPreviewNode = useCallback(
		(node: HTMLVideoElement | null) => {
			recordingWebcamPreviewRef.current = node;
			attachPreviewStreamToNode(node);
		},
		[attachPreviewStreamToNode],
	);

	useEffect(() => {
		return () => {
			if (previewDragMoveRafRef.current !== null) {
				cancelAnimationFrame(previewDragMoveRafRef.current);
			}
			previewDragMoveRafRef.current = null;
			previewDragPendingPointerRef.current = null;
		};
	}, []);

	useEffect(() => {
		let mounted = true;
		let sessionHandle: WebcamSessionHandle | null = null;

		const startPreview = async () => {
			if (!shouldStreamWebcamPreview) {
				return;
			}

			try {
				// Shared session: the recorder may hold the same camera. Acquiring
				// through the session manager (instead of a second getUserMedia)
				// avoids restarting the device, which stalls frame delivery for
				// seconds on cameras like iPhone Continuity Camera.
				const handle = await acquireWebcamSession(
					webcamDeviceId,
					webcamFrameRate,
					webcamQualityMode,
				);

				if (!mounted) {
					handle.release();
					return;
				}

				sessionHandle = handle;
				previewStreamRef.current = handle.stream;
				attachPreviewStreamToNode(webcamPreviewRef.current);
				attachPreviewStreamToNode(recordingWebcamPreviewRef.current);
			} catch (error) {
				console.warn("Failed to start live webcam preview:", error);
			}
		};

		void startPreview();

		return () => {
			mounted = false;
			const previewNode = webcamPreviewRef.current;
			const recordingPreviewNode = recordingWebcamPreviewRef.current;
			const previewStream = previewStreamRef.current;

			[previewNode, recordingPreviewNode]
				.filter((node): node is HTMLVideoElement => Boolean(node))
				.forEach((videoElement) => {
					videoElement.pause();
					videoElement.srcObject = null;
				});
			// Release the shared session instead of stopping tracks; the device
			// only powers down once no other consumer (e.g. recorder) holds it.
			sessionHandle?.release();
			sessionHandle = null;
			if (previewStreamRef.current === previewStream) {
				previewStreamRef.current = null;
			}
		};
	}, [
		attachPreviewStreamToNode,
		shouldStreamWebcamPreview,
		webcamDeviceId,
		webcamFrameRate,
		webcamQualityMode,
	]);

	useEffect(() => {
		if (!shouldStreamNativePreview) {
			return;
		}

		let cancelled = false;
		const qualityProfile = getWebcamQualityProfile(webcamQualityMode);
		setNativePreviewStartIssue(null);

		const startNativePreview = async () => {
			const result = await window.electronAPI?.startNativeWebcamPreview?.({
				webcamDeviceId: nativePreviewDeviceId ?? null,
				webcamLabel: nativePreviewLabel ?? null,
				webcamWidth: qualityProfile.idealWidth,
				webcamHeight: qualityProfile.idealHeight,
				webcamFPS: Math.min(webcamFrameRate, 30),
			});

			if (cancelled) {
				await window.electronAPI?.stopNativeWebcamPreview?.({
					reason: getNativeWebcamPreviewStopReason(recordingActiveRef.current),
				});
				return;
			}

			if (!result?.success) {
				console.warn("Failed to start native webcam proof preview:", result?.error);
				setNativePreviewStartIssue(result?.error ?? "native-preview-start-failed");
			}
		};

		void startNativePreview();

		return () => {
			cancelled = true;
			void window.electronAPI?.stopNativeWebcamPreview?.({
				reason: getNativeWebcamPreviewStopReason(recordingActiveRef.current),
			});
		};
	}, [
		nativePreviewDeviceId,
		nativePreviewLabel,
		shouldStreamNativePreview,
		webcamFrameRate,
		webcamQualityMode,
	]);

	const nativePreviewDisplayUrl = nativePreviewPreferred
		? selectNativeWebcamPreviewDisplayUrl(nativePreviewState)
		: null;
	useEffect(() => {
		if (!nativePreviewDisplayUrl) {
			resetNativePreviewImagePump();
			return;
		}
		nativePreviewPumpStateRef.current = queueNativeWebcamPreviewImageFrame(
			nativePreviewPumpStateRef.current,
			nativePreviewDisplayUrl,
		);
		if (nativeVisiblePreviewStartedAtRef.current === null) {
			nativeVisiblePreviewStartedAtRef.current = Date.now();
		}
		pumpNativePreviewImage();
	}, [nativePreviewDisplayUrl, pumpNativePreviewImage, resetNativePreviewImagePump]);
	const nativePreviewUrl = selectRenderableNativePreviewUrl({
		assignedUrl: assignedNativePreviewUrl,
		failedUrl: failedNativePreviewUrl,
	});
	const nativePreviewImageIssue =
		Boolean(assignedNativePreviewUrl) && assignedNativePreviewUrl === failedNativePreviewUrl;
	const nativePreviewIssue = hasNativeWebcamPreviewIssue({
		nativePreviewPreferred,
		nativePreviewStartIssue,
		nativePreviewImageIssue,
	});

	return {
		showFloatingWebcamPreview,
		setShowFloatingWebcamPreview,
		webcamPreviewOffset,
		nativePreviewUrl,
		nativePreviewImageIssue: nativePreviewIssue,
		handleNativePreviewImageLoad,
		handleNativePreviewImageError,
		nativePreviewPreferred,
		recordingWebcamPreviewContainerRef,
		isWebcamPreviewDraggingRef,
		webcamPreviewDragStartRef,
		handleWebcamPreviewPointerDown,
		handleWebcamPreviewPointerMove,
		handleWebcamPreviewPointerUp,
		setWebcamPreviewNode,
		setRecordingWebcamPreviewNode,
		showRecordingWebcamPreview,
	};
}

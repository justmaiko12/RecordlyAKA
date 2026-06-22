import {
	CaretDownIcon,
	CaretUpIcon,
	MinusIcon,
	PauseIcon,
	PencilSimpleIcon,
	PlayIcon,
	PlusIcon,
	VideoCameraIcon,
	VideoCameraSlashIcon,
	XIcon,
} from "@phosphor-icons/react";
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useScopedT } from "@/contexts/I18nContext";
import {
	blankNativeWebcamPreviewImageDisplay,
	buildNativeWebcamPreviewProbeUrl,
	commitNativeWebcamPreviewImageAssignment,
	createInitialNativeWebcamPreviewState,
	createInitialNativeWebcamPreviewImagePumpState,
	completeNativeWebcamPreviewImageLoad,
	expireNativeWebcamPreviewFrame,
	failNativeWebcamPreviewImageLoad,
	hasNativeWebcamPreviewMountStateChanged,
	isNativeWebcamPreviewVisibleLoadStale,
	NATIVE_WEBCAM_PREVIEW_MAX_IMAGE_LOAD_MS,
	NATIVE_WEBCAM_PREVIEW_PROBE_TIMEOUT_MS,
	queueNativeWebcamPreviewImageFrame,
	reduceNativeWebcamPreviewEvent,
	selectNativeWebcamPreviewDisplayUrl,
	selectNativeWebcamPreviewImageAssignment,
	shouldRequestNativeWebcamPreviewProbe,
} from "@/lib/nativeWebcamPreview";
import {
	acquireWebcamSession,
	DEFAULT_WEBCAM_FRAME_RATE,
	DEFAULT_WEBCAM_QUALITY_MODE,
	type WebcamSessionHandle,
} from "@/lib/webcamSession";
import {
	CAMERA_OPACITY_MAX,
	CAMERA_OPACITY_MIN,
	clampCameraOpacity,
	getTeleprompterBrowserCameraCandidates,
	getTeleprompterNativePreviewUnavailableEvent,
	getNativeTeleprompterPreviewStopReason,
	isNativeTeleprompterPreviewSessionActive,
	parseStoredCameraOpacity,
	reduceTeleprompterNativePreviewSurfaceState,
	shouldAcquireTeleprompterBrowserCamera,
	type TeleprompterNativePreviewSurfaceEvent,
} from "./teleprompterCamera";
import {
	advanceScrollTop,
	DEFAULT_FONT_SIZE_INDEX,
	DEFAULT_SPEED_INDEX,
	FONT_SIZES,
	SPEED_LEVELS,
	stepIndex,
} from "./teleprompterScroll";

const SCRIPT_STORAGE_KEY = "recordly-teleprompter-script";
const SPEED_STORAGE_KEY = "recordly-teleprompter-speed-index";
const FONT_STORAGE_KEY = "recordly-teleprompter-font-index";
const CAMERA_ON_STORAGE_KEY = "recordly-teleprompter-camera-on";
const CAMERA_OPACITY_STORAGE_KEY = "recordly-teleprompter-camera-opacity";
const NATIVE_TELEPROMPTER_PREVIEW_MIN_RENDER_MS = 33;

const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragRegion = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function NativeTeleprompterCameraPreview({
	cameraOn,
	onPreviewIssueChange,
	opacity,
	recordingActive,
}: {
	cameraOn: boolean;
	onPreviewIssueChange?: (hasIssue: boolean) => void;
	opacity: number;
	recordingActive: boolean;
}) {
	const [nativePreviewState, setNativePreviewState] = useState(
		createInitialNativeWebcamPreviewState,
	);
	const [assignedNativePreviewUrl, setAssignedNativePreviewUrl] = useState<string | null>(null);
	const [probeUrl, setProbeUrl] = useState<string | null>(null);
	const [visiblePreviewBlocked, setVisiblePreviewBlocked] = useState(false);
	const nativePreviewLatestStateRef = useRef(nativePreviewState);
	const nativePreviewRenderedStateRef = useRef(nativePreviewState);
	const nativePreviewPumpStateRef = useRef(createInitialNativeWebcamPreviewImagePumpState());
	const nativePreviewRenderTimerRef = useRef<number | null>(null);
	const nativePreviewSwapTimerRef = useRef<number | null>(null);
	const lastNativePreviewRenderAtRef = useRef(0);
	const visiblePreviewRef = useRef<HTMLImageElement | null>(null);
	const activeNativeVisiblePreviewUrlRef = useRef<string | null>(null);
	const visiblePreviewStartedAtRef = useRef<number | null>(null);
	const lastVisiblePreviewLoadAtRef = useRef<number | null>(null);
	const lastProbeRequestedAtRef = useRef<number | null>(null);
	const activeProbeUrlRef = useRef<string | null>(null);
	const probeTimeoutRef = useRef<number | null>(null);
	const previewIssueRef = useRef(false);
	const visiblePreviewBlockedRef = useRef(false);
	const previewIssueReasonRef = useRef<"proof" | "visible" | null>(null);

	const clearProbeTimeout = useCallback(() => {
		if (probeTimeoutRef.current !== null) {
			window.clearTimeout(probeTimeoutRef.current);
			probeTimeoutRef.current = null;
		}
	}, []);

	const clearNativePreviewSwapTimer = useCallback(() => {
		if (nativePreviewSwapTimerRef.current !== null) {
			window.clearTimeout(nativePreviewSwapTimerRef.current);
			nativePreviewSwapTimerRef.current = null;
		}
	}, []);

	const setPreviewIssue = useCallback(
		(hasIssue: boolean) => {
			if (previewIssueRef.current === hasIssue) {
				return;
			}
			previewIssueRef.current = hasIssue;
			onPreviewIssueChange?.(hasIssue);
		},
		[onPreviewIssueChange],
	);

	const setVisiblePreviewBlockedState = useCallback((blocked: boolean) => {
		if (visiblePreviewBlockedRef.current === blocked) {
			return;
		}
		visiblePreviewBlockedRef.current = blocked;
		setVisiblePreviewBlocked(blocked);
	}, []);

	const applyPreviewSurfaceState = useCallback(
		(nextState: {
			previewIssue: boolean;
			visiblePreviewBlocked: boolean;
			issueReason: "proof" | "visible" | null;
		}) => {
			previewIssueReasonRef.current = nextState.issueReason;
			setPreviewIssue(nextState.previewIssue);
			setVisiblePreviewBlockedState(nextState.visiblePreviewBlocked);
		},
		[setPreviewIssue, setVisiblePreviewBlockedState],
	);

	const reducePreviewSurfaceState = useCallback(
		(event: TeleprompterNativePreviewSurfaceEvent) => {
			applyPreviewSurfaceState(
				reduceTeleprompterNativePreviewSurfaceState(
					{
						previewIssue: previewIssueRef.current,
						visiblePreviewBlocked: visiblePreviewBlockedRef.current,
						issueReason: previewIssueReasonRef.current,
					},
					event,
				),
			);
		},
		[applyPreviewSurfaceState],
	);

	const resetNativePreviewImagePump = useCallback(() => {
		clearNativePreviewSwapTimer();
		nativePreviewPumpStateRef.current = createInitialNativeWebcamPreviewImagePumpState();
		activeNativeVisiblePreviewUrlRef.current = null;
		visiblePreviewStartedAtRef.current = null;
		lastVisiblePreviewLoadAtRef.current = null;
		setAssignedNativePreviewUrl(null);
	}, [clearNativePreviewSwapTimer]);

	const pumpNativePreviewImage = useCallback(() => {
		if (nativePreviewSwapTimerRef.current !== null) {
			return;
		}

		const assignment = selectNativeWebcamPreviewImageAssignment(
			nativePreviewPumpStateRef.current,
			Date.now(),
			NATIVE_TELEPROMPTER_PREVIEW_MIN_RENDER_MS,
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
		if (visiblePreviewStartedAtRef.current === null) {
			visiblePreviewStartedAtRef.current = Date.now();
		}
		setAssignedNativePreviewUrl(assignment.url);
	}, []);

	const reportNativePreviewRendererIssue = useCallback(
		(
			issue: string,
			previewUrl?: string | null,
			nowMs = Date.now(),
			details?: Record<string, string | number | boolean | null>,
		) => {
			void window.electronAPI
				?.reportNativeWebcamPreviewRendererIssue?.({
					surface: "teleprompter-preview",
					issue,
					previewUrl: previewUrl ?? null,
					visibleStartedAtMs: visiblePreviewStartedAtRef.current,
					lastVisibleLoadAtMs: lastVisiblePreviewLoadAtRef.current,
					nowMs,
					recordingActive,
					details: {
						activeProbeUrl: activeProbeUrlRef.current,
						...(details ?? {}),
					},
				})
				.catch((error) => {
					console.warn("Failed to report native teleprompter preview issue:", error);
				});
		},
		[recordingActive],
	);

	const resetPreviewProbe = useCallback(() => {
		clearProbeTimeout();
		lastProbeRequestedAtRef.current = null;
		activeProbeUrlRef.current = null;
		visiblePreviewStartedAtRef.current = null;
		lastVisiblePreviewLoadAtRef.current = null;
		setProbeUrl(null);
		resetNativePreviewImagePump();
		reducePreviewSurfaceState({ type: "reset" });
	}, [clearProbeTimeout, reducePreviewSurfaceState, resetNativePreviewImagePump]);

	const commitNativePreviewState = useCallback((nextState: typeof nativePreviewState) => {
		if (nativePreviewRenderTimerRef.current !== null) {
			window.clearTimeout(nativePreviewRenderTimerRef.current);
			nativePreviewRenderTimerRef.current = null;
		}

		nativePreviewRenderedStateRef.current = nextState;
		lastNativePreviewRenderAtRef.current = Date.now();
		setNativePreviewState((currentState) =>
			hasNativeWebcamPreviewMountStateChanged(currentState, nextState)
				? nextState
				: currentState,
		);
	}, []);

	const flushNativePreviewState = useCallback(
		(force = false) => {
			const nextState = nativePreviewLatestStateRef.current;
			const renderedState = nativePreviewRenderedStateRef.current;
			if (!hasNativeWebcamPreviewMountStateChanged(renderedState, nextState)) {
				return;
			}

			const now = Date.now();
			const elapsedMs = now - lastNativePreviewRenderAtRef.current;
			const renderedUrl = selectNativeWebcamPreviewDisplayUrl(renderedState);
			const nextUrl = selectNativeWebcamPreviewDisplayUrl(nextState);
			const shouldRenderNow =
				force ||
				renderedState.active !== nextState.active ||
				renderedState.stale !== nextState.stale ||
				!renderedUrl ||
				!nextUrl ||
				elapsedMs >= NATIVE_TELEPROMPTER_PREVIEW_MIN_RENDER_MS;

			if (shouldRenderNow) {
				commitNativePreviewState(nextState);
				return;
			}

			if (nativePreviewRenderTimerRef.current !== null) {
				return;
			}

			nativePreviewRenderTimerRef.current = window.setTimeout(() => {
				nativePreviewRenderTimerRef.current = null;
				commitNativePreviewState(nativePreviewLatestStateRef.current);
			}, NATIVE_TELEPROMPTER_PREVIEW_MIN_RENDER_MS - elapsedMs);
		},
		[commitNativePreviewState],
	);

	useEffect(() => {
		return () => {
			if (nativePreviewRenderTimerRef.current !== null) {
				window.clearTimeout(nativePreviewRenderTimerRef.current);
				nativePreviewRenderTimerRef.current = null;
			}
			clearProbeTimeout();
			clearNativePreviewSwapTimer();
		};
	}, [clearNativePreviewSwapTimer, clearProbeTimeout]);

	const applyNativePreviewState = useCallback(
		(nextState: typeof nativePreviewState, forceRender = false) => {
			nativePreviewLatestStateRef.current = nextState;
			flushNativePreviewState(forceRender);
		},
		[flushNativePreviewState],
	);

	const expireLatestNativePreviewState = useCallback(() => {
		const previousState = nativePreviewLatestStateRef.current;
		const nextState = expireNativeWebcamPreviewFrame(previousState, Date.now());
		if (nextState === previousState) {
			return;
		}

		applyNativePreviewState(nextState, true);
	}, [applyNativePreviewState]);

	useEffect(() => {
		nativePreviewRenderedStateRef.current = nativePreviewState;
	}, [nativePreviewState]);

	useEffect(() => {
		const unsubscribe = window.electronAPI?.onNativeWebcamPreview?.((state) => {
			const now = Date.now();
			const nextPreviewState = reduceNativeWebcamPreviewEvent(
				nativePreviewLatestStateRef.current,
				state,
				now,
			);
			applyNativePreviewState(nextPreviewState);
			if (!state.active || state.status === "stopped") {
				resetPreviewProbe();
				return;
			}
			const snapshotUrl = typeof state.url === "string" && state.url ? state.url : null;
			if (state.status === "frame" && snapshotUrl !== null) {
				nativePreviewPumpStateRef.current = queueNativeWebcamPreviewImageFrame(
					nativePreviewPumpStateRef.current,
					snapshotUrl,
				);
				if (visiblePreviewStartedAtRef.current === null) {
					visiblePreviewStartedAtRef.current = now;
				}
				pumpNativePreviewImage();
			}
			if (
				state.status === "frame" &&
				snapshotUrl !== null &&
				shouldRequestNativeWebcamPreviewProbe({
					nowMs: now,
					lastProbeRequestedAtMs: lastProbeRequestedAtRef.current,
					snapshotUrl,
				})
			) {
				const nextProbeUrl = buildNativeWebcamPreviewProbeUrl(snapshotUrl, now);
				lastProbeRequestedAtRef.current = now;
				activeProbeUrlRef.current = nextProbeUrl;
				setProbeUrl(nextProbeUrl);
				clearProbeTimeout();
				probeTimeoutRef.current = window.setTimeout(() => {
					if (activeProbeUrlRef.current === nextProbeUrl) {
						reportNativePreviewRendererIssue("probe-timeout", nextProbeUrl);
						reducePreviewSurfaceState({ type: "proof-unreadable" });
					}
				}, NATIVE_WEBCAM_PREVIEW_PROBE_TIMEOUT_MS);
			}
		});
		return unsubscribe;
	}, [
		applyNativePreviewState,
		clearProbeTimeout,
		pumpNativePreviewImage,
		reducePreviewSurfaceState,
		reportNativePreviewRendererIssue,
		resetPreviewProbe,
	]);

	useEffect(() => {
		const interval = window.setInterval(() => {
			const now = Date.now();
			expireLatestNativePreviewState();
			const visiblePreviewUrl = activeNativeVisiblePreviewUrlRef.current;
			if (
				isNativeWebcamPreviewVisibleLoadStale({
					nowMs: now,
					previewUrl: visiblePreviewUrl,
					visibleStartedAtMs: visiblePreviewStartedAtRef.current,
					lastVisibleLoadAtMs: lastVisiblePreviewLoadAtRef.current,
				})
			) {
				reportNativePreviewRendererIssue("visible-load-stale", visiblePreviewUrl, now);
				reducePreviewSurfaceState({ type: "visible-stream-failed" });
				nativePreviewPumpStateRef.current = blankNativeWebcamPreviewImageDisplay(
					nativePreviewPumpStateRef.current,
				);
				activeNativeVisiblePreviewUrlRef.current = null;
				setAssignedNativePreviewUrl(null);
				pumpNativePreviewImage();
			}
		}, 250);

		return () => window.clearInterval(interval);
	}, [
		expireLatestNativePreviewState,
		pumpNativePreviewImage,
		reducePreviewSurfaceState,
		reportNativePreviewRendererIssue,
	]);

	useEffect(() => {
		if (!cameraOn) {
			resetPreviewProbe();
		}
	}, [cameraOn, resetPreviewProbe]);

	const handleProbeLoad = useCallback(
		(event: SyntheticEvent<HTMLImageElement>) => {
			const loadedUrl = event.currentTarget.currentSrc || event.currentTarget.src;
			if (loadedUrl !== activeProbeUrlRef.current) {
				return;
			}
			clearProbeTimeout();
			reducePreviewSurfaceState({ type: "proof-readable" });
		},
		[clearProbeTimeout, reducePreviewSurfaceState],
	);

	const handleProbeError = useCallback(
		(event: SyntheticEvent<HTMLImageElement>) => {
			const failedUrl = event.currentTarget.currentSrc || event.currentTarget.src;
			if (failedUrl === activeProbeUrlRef.current) {
				clearProbeTimeout();
				reportNativePreviewRendererIssue("probe-image-error", failedUrl);
				reducePreviewSurfaceState({ type: "proof-unreadable" });
			}
		},
		[clearProbeTimeout, reducePreviewSurfaceState, reportNativePreviewRendererIssue],
	);

	const proofPreviewUrl = selectNativeWebcamPreviewDisplayUrl(nativePreviewState);
	const previewUrl = assignedNativePreviewUrl;
	useEffect(() => {
		if (!cameraOn || !nativePreviewState.active || nativePreviewState.stale) {
			visiblePreviewStartedAtRef.current = null;
			lastVisiblePreviewLoadAtRef.current = null;
			reducePreviewSurfaceState(
				getTeleprompterNativePreviewUnavailableEvent({
					cameraOn,
					nativePreviewActive: nativePreviewState.active,
					nativePreviewStale: nativePreviewState.stale,
				}),
			);
			return;
		}
		if (!proofPreviewUrl) {
			reducePreviewSurfaceState({ type: "reset" });
			return;
		}
		if (!previewUrl) {
			return;
		}
		if (visiblePreviewStartedAtRef.current === null) {
			visiblePreviewStartedAtRef.current = Date.now();
		}
	}, [
		cameraOn,
		nativePreviewState.active,
		nativePreviewState.stale,
		proofPreviewUrl,
		previewUrl,
		reducePreviewSurfaceState,
	]);

	const setVisiblePreviewNode = useCallback((node: HTMLImageElement | null) => {
		visiblePreviewRef.current = node;
	}, []);

	const handleVisiblePreviewLoad = useCallback(
		(event: SyntheticEvent<HTMLImageElement>) => {
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
			const now = Date.now();
			if (visiblePreviewStartedAtRef.current === null) {
				visiblePreviewStartedAtRef.current = now;
			}
			lastVisiblePreviewLoadAtRef.current = now;
			reducePreviewSurfaceState({ type: "visible-stream-loaded" });
			pumpNativePreviewImage();
		},
		[pumpNativePreviewImage, reducePreviewSurfaceState],
	);

	const handleVisiblePreviewError = useCallback(() => {
		const failedUrl =
			visiblePreviewRef.current?.currentSrc || visiblePreviewRef.current?.src || null;
		reportNativePreviewRendererIssue("visible-image-error", failedUrl);
		nativePreviewPumpStateRef.current = failNativeWebcamPreviewImageLoad(
			nativePreviewPumpStateRef.current,
		);
		if (!failedUrl || activeNativeVisiblePreviewUrlRef.current === failedUrl) {
			activeNativeVisiblePreviewUrlRef.current = null;
			setAssignedNativePreviewUrl(null);
		}
		reducePreviewSurfaceState({ type: "visible-stream-failed" });
		pumpNativePreviewImage();
	}, [pumpNativePreviewImage, reducePreviewSurfaceState, reportNativePreviewRendererIssue]);

	if (!cameraOn || !nativePreviewState.active || nativePreviewState.stale || !previewUrl) {
		return probeUrl ? (
			<img
				src={probeUrl}
				alt=""
				aria-hidden="true"
				className="pointer-events-none absolute h-px w-px opacity-0"
				decoding="async"
				draggable={false}
				onError={handleProbeError}
				onLoad={handleProbeLoad}
			/>
		) : null;
	}

	return (
		<>
			<img
				ref={setVisiblePreviewNode}
				src={previewUrl}
				alt=""
				className="pointer-events-none absolute inset-0 h-full w-full object-cover"
				decoding="async"
				draggable={false}
				onError={handleVisiblePreviewError}
				onLoad={handleVisiblePreviewLoad}
				style={{ transform: "scaleX(-1)", opacity: visiblePreviewBlocked ? 0 : opacity }}
			/>
			{probeUrl && (
				<img
					src={probeUrl}
					alt=""
					aria-hidden="true"
					className="pointer-events-none absolute h-px w-px opacity-0"
					decoding="async"
					draggable={false}
					onError={handleProbeError}
					onLoad={handleProbeLoad}
				/>
			)}
		</>
	);
}

function loadStoredIndex(key: string, fallback: number, length: number): number {
	const raw = Number.parseInt(window.localStorage.getItem(key) ?? "", 10);
	if (!Number.isFinite(raw) || raw < 0 || raw >= length) {
		return fallback;
	}
	return raw;
}

export function Teleprompter() {
	const t = useScopedT("launch");
	const [script, setScript] = useState(
		() => window.localStorage.getItem(SCRIPT_STORAGE_KEY) ?? "",
	);
	const [editing, setEditing] = useState(
		() => (window.localStorage.getItem(SCRIPT_STORAGE_KEY) ?? "").trim().length === 0,
	);
	const [playing, setPlaying] = useState(false);
	const [speedIndex, setSpeedIndex] = useState(() =>
		loadStoredIndex(SPEED_STORAGE_KEY, DEFAULT_SPEED_INDEX, SPEED_LEVELS.length),
	);
	const [fontIndex, setFontIndex] = useState(() =>
		loadStoredIndex(FONT_STORAGE_KEY, DEFAULT_FONT_SIZE_INDEX, FONT_SIZES.length),
	);
	const [cameraOn, setCameraOn] = useState(
		() => window.localStorage.getItem(CAMERA_ON_STORAGE_KEY) === "true",
	);
	const [cameraOpacity, setCameraOpacity] = useState(() =>
		parseStoredCameraOpacity(window.localStorage.getItem(CAMERA_OPACITY_STORAGE_KEY)),
	);
	const [cameraError, setCameraError] = useState(false);
	const [nativePreviewIssue, setNativePreviewIssue] = useState(false);
	const [recordingActive, setRecordingActive] = useState(false);
	const [nativePreviewActive, setNativePreviewActive] = useState(false);
	const [platform, setPlatform] = useState<string | null>(null);

	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const scrollPositionRef = useRef(0);
	const speedIndexRef = useRef(speedIndex);
	const editingRef = useRef(editing);
	const autoScrollingRef = useRef(false);
	const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
	const cameraStreamRef = useRef<MediaStream | null>(null);
	const cameraSessionHandleRef = useRef<WebcamSessionHandle | null>(null);
	const cameraOnRef = useRef(cameraOn);
	const nativePreviewSessionActiveRef = useRef(false);
	const recordingActiveRef = useRef(false);
	const nativePreviewPreferred = platform === null || platform === "darwin";

	const releaseCameraSession = useCallback(() => {
		cameraSessionHandleRef.current?.release();
		cameraSessionHandleRef.current = null;
		cameraStreamRef.current = null;
		if (cameraVideoRef.current) {
			cameraVideoRef.current.srcObject = null;
		}
	}, []);

	useEffect(() => {
		window.localStorage.setItem(SCRIPT_STORAGE_KEY, script);
	}, [script]);

	useEffect(() => {
		window.localStorage.setItem(SPEED_STORAGE_KEY, String(speedIndex));
		speedIndexRef.current = speedIndex;
	}, [speedIndex]);

	useEffect(() => {
		window.localStorage.setItem(FONT_STORAGE_KEY, String(fontIndex));
	}, [fontIndex]);

	useEffect(() => {
		editingRef.current = editing;
	}, [editing]);

	useEffect(() => {
		window.localStorage.setItem(CAMERA_ON_STORAGE_KEY, String(cameraOn));
		cameraOnRef.current = cameraOn;
	}, [cameraOn]);

	useEffect(() => {
		window.localStorage.setItem(CAMERA_OPACITY_STORAGE_KEY, String(cameraOpacity));
	}, [cameraOpacity]);

	useEffect(() => {
		let mounted = true;
		void window.electronAPI
			?.getPlatform?.()
			.then((nextPlatform) => {
				if (mounted) {
					setPlatform(nextPlatform);
				}
			})
			.catch(() => {
				if (mounted) {
					setPlatform("unknown");
				}
			});
		return () => {
			mounted = false;
		};
	}, []);

	useEffect(() => {
		const unsubscribe = window.electronAPI?.onRecordingStateChanged?.((state) => {
			recordingActiveRef.current = state.recording;
			setRecordingActive(state.recording);
			if (state.recording) {
				releaseCameraSession();
			} else {
				setCameraError(false);
			}
		});
		return unsubscribe;
	}, [releaseCameraSession]);

	useEffect(() => {
		const unsubscribe = window.electronAPI?.onNativeWebcamPreview?.((state) => {
			const nativePreviewSessionActive = isNativeTeleprompterPreviewSessionActive(state);
			const wasNativePreviewSessionActive = nativePreviewSessionActiveRef.current;

			if (nativePreviewSessionActive !== wasNativePreviewSessionActive) {
				setNativePreviewActive(nativePreviewSessionActive);
			}

			if (nativePreviewSessionActive && !wasNativePreviewSessionActive) {
				setCameraError(false);
				releaseCameraSession();
				setCameraOn(true);
			} else if (recordingActiveRef.current && state.status === "stopped") {
				setCameraError(true);
				releaseCameraSession();
			} else if (!recordingActiveRef.current && state.status === "stopped") {
				const stopReason =
					typeof state.details?.reason === "string" ? state.details.reason : null;
				const intentionalStop =
					stopReason === "renderer-stop" ||
					stopReason === "recording-start" ||
					stopReason === "replaced";
				if (cameraOnRef.current && !editingRef.current && !intentionalStop) {
					setCameraError(true);
					setCameraOn(false);
					releaseCameraSession();
				}
			}
			nativePreviewSessionActiveRef.current = nativePreviewSessionActive;
		});
		return unsubscribe;
	}, [releaseCameraSession]);

	useEffect(() => {
		if (!cameraOn || editing || recordingActive || platform !== "darwin") {
			return;
		}
		if (nativePreviewSessionActiveRef.current) {
			return;
		}

		let cancelled = false;

		void (async () => {
			setCameraError(false);
			const selectedDeviceId = await window.electronAPI
				?.getSelectedWebcamDevice?.()
				.catch(() => null);
			const [browserDevices, nativeResult] = await Promise.all([
				navigator.mediaDevices
					.enumerateDevices()
					.then((devices) => devices.filter((device) => device.kind === "videoinput"))
					.catch(() => [] as MediaDeviceInfo[]),
				window.electronAPI?.getVideoDeviceConnectionInfo?.().catch(() => null),
			]);
			const nativeDevices = nativeResult?.success ? nativeResult.devices : [];
			const selectedNativeDevice = nativeDevices.find(
				(device) =>
					typeof selectedDeviceId === "string" &&
					device.uniqueId?.trim() === selectedDeviceId.trim(),
			);
			const selectedBrowserDevice = browserDevices.find(
				(device) =>
					typeof selectedDeviceId === "string" && device.deviceId === selectedDeviceId,
			);
			const result = await window.electronAPI?.startNativeWebcamPreview?.({
				webcamDeviceId: selectedNativeDevice?.uniqueId ?? null,
				webcamLabel: selectedNativeDevice?.label ?? selectedBrowserDevice?.label ?? null,
				webcamWidth: 1280,
				webcamHeight: 720,
				webcamFPS: DEFAULT_WEBCAM_FRAME_RATE,
			});

			if (cancelled) {
				void window.electronAPI?.stopNativeWebcamPreview?.({
					reason: getNativeTeleprompterPreviewStopReason(recordingActiveRef.current),
				});
				return;
			}

			if (!result?.success) {
				console.warn("Native teleprompter webcam proof preview failed:", result);
				setCameraError(true);
				setCameraOn(false);
			}
		})();

		return () => {
			cancelled = true;
			void window.electronAPI?.stopNativeWebcamPreview?.({
				reason: getNativeTeleprompterPreviewStopReason(recordingActiveRef.current),
			});
		};
	}, [cameraOn, editing, platform, recordingActive]);

	// Camera stream lifecycle — runs only in read mode with the toggle on.
	useEffect(() => {
		if (
			!shouldAcquireTeleprompterBrowserCamera({
				cameraOn,
				editing,
				nativePreviewActive,
				nativePreviewPreferred,
				recordingActive,
			})
		) {
			return;
		}
		let cancelled = false;

		void (async () => {
			setCameraError(false);
			const deviceId = await window.electronAPI
				?.getSelectedWebcamDevice?.()
				.catch(() => null);
			const browserDeviceIds = await navigator.mediaDevices
				.enumerateDevices()
				.then((devices) =>
					devices
						.filter((device) => device.kind === "videoinput")
						.map((device) => device.deviceId),
				)
				.catch(() => []);
			const nativeDeviceIds = await window.electronAPI
				?.getVideoDeviceConnectionInfo?.()
				.then((result) =>
					result.success
						? result.devices
								.map((device) => device.uniqueId?.trim())
								.filter((id): id is string => Boolean(id))
						: [],
				)
				.catch(() => []);
			const deviceIds = getTeleprompterBrowserCameraCandidates({
				selectedDeviceId: deviceId,
				browserDeviceIds,
				nativeDeviceIds,
			});
			for (const candidateDeviceId of deviceIds) {
				try {
					const handle = await acquireWebcamSession(
						candidateDeviceId ?? undefined,
						DEFAULT_WEBCAM_FRAME_RATE,
						DEFAULT_WEBCAM_QUALITY_MODE,
					);
					if (cancelled) {
						handle.release();
						return;
					}
					cameraSessionHandleRef.current = handle;
					cameraStreamRef.current = handle.stream;
					if (cameraVideoRef.current) {
						cameraVideoRef.current.srcObject = handle.stream;
					}
					return;
				} catch {
					// Try the next (less strict) constraints.
				}
			}
			if (!cancelled) {
				setCameraError(true);
				setCameraOn(false);
			}
		})();

		return () => {
			cancelled = true;
			releaseCameraSession();
		};
	}, [
		cameraOn,
		editing,
		nativePreviewActive,
		nativePreviewPreferred,
		recordingActive,
		releaseCameraSession,
	]);

	// Auto-scroll loop. Fractional position lives in scrollPositionRef so slow
	// speeds accumulate sub-pixel movement instead of stalling.
	useEffect(() => {
		if (!playing || editing) {
			return;
		}
		let frame = 0;
		let lastTime: number | null = null;
		const tick = (time: number) => {
			const container = scrollContainerRef.current;
			if (container && lastTime !== null) {
				const next = advanceScrollTop(
					scrollPositionRef.current,
					SPEED_LEVELS[speedIndexRef.current],
					time - lastTime,
				);
				const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
				scrollPositionRef.current = Math.min(next, maxScroll);
				autoScrollingRef.current = true;
				container.scrollTop = scrollPositionRef.current;
				autoScrollingRef.current = false;
				if (scrollPositionRef.current >= maxScroll) {
					setPlaying(false);
					return;
				}
			}
			lastTime = time;
			frame = window.requestAnimationFrame(tick);
		};
		frame = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(frame);
	}, [playing, editing]);

	const togglePlay = useCallback(() => {
		if (editingRef.current) {
			// Entering read mode mounts a fresh container at scrollTop 0; reset the
			// position ref to match so playback starts from the top, not a stale spot.
			scrollPositionRef.current = 0;
			setEditing(false);
			setPlaying(true);
			return;
		}
		setPlaying((was) => !was);
	}, []);

	// Global hotkeys relayed from the main process.
	useEffect(() => {
		const unsubscribe = window.electronAPI?.onTeleprompterCommand?.((command) => {
			if (command === "toggle-play") {
				togglePlay();
			} else if (command === "speed-down") {
				setSpeedIndex((index) => stepIndex(index, -1, SPEED_LEVELS.length));
			} else if (command === "speed-up") {
				setSpeedIndex((index) => stepIndex(index, 1, SPEED_LEVELS.length));
			}
		});
		return unsubscribe;
	}, [togglePlay]);

	// Manual scrolling always works and pauses auto-scroll.
	const handleWheel = useCallback(() => {
		setPlaying(false);
	}, []);

	// Note: scroll events fire async, so autoScrollingRef is a best-effort guard —
	// programmatic scrolls can still reach this handler. That's harmless because it
	// only syncs the position ref; pause logic must stay on onWheel, never onScroll.
	const handleScroll = useCallback(() => {
		const container = scrollContainerRef.current;
		if (container && !autoScrollingRef.current) {
			scrollPositionRef.current = container.scrollTop;
		}
	}, []);

	const startReading = useCallback(() => {
		scrollPositionRef.current = 0;
		setEditing(false);
	}, []);

	const backToEdit = useCallback(() => {
		setPlaying(false);
		setEditing(true);
	}, []);

	// Camera-full layout mode relayed from the recording HUD: highlight the
	// window blue so the reader knows only the facecam is in frame.
	const [cameraFullLayout, setCameraFullLayout] = useState(false);
	useEffect(() => {
		const unsubscribe = window.electronAPI?.onTeleprompterCameraMode?.((mode) => {
			setCameraFullLayout(mode === "camera-full");
		});
		return unsubscribe;
	}, []);

	return (
		<div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#161616] text-neutral-100">
			{cameraFullLayout && (
				<div className="pointer-events-none absolute inset-0 z-50 border-[3px] border-blue-500" />
			)}
			<header
				className="flex h-9 shrink-0 items-center gap-2 border-b border-white/10 px-3"
				style={dragRegion}
			>
				<span
					className={`select-none text-xs font-medium ${
						cameraFullLayout ? "text-blue-400" : "text-neutral-400"
					}`}
				>
					{t("teleprompter.menuLabel", "Teleprompter")}
				</span>
				<span className="select-none truncate text-[10px] text-neutral-600">
					{t("teleprompter.hotkeyHint", "⌥F8 play/pause · ⌥F7/⌥F9 speed · ⌥T show/hide")}
				</span>
				{cameraError && (
					<span className="select-none text-[10px] text-red-400">
						{t("teleprompter.cameraError", "Camera unavailable")}
					</span>
				)}
				{!cameraError && nativePreviewIssue && (
					<span className="select-none text-[10px] text-amber-400">
						{t("teleprompter.previewIssue", "Preview reconnecting")}
					</span>
				)}
				<div className="ml-auto flex items-center gap-1" style={noDragRegion}>
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6 text-neutral-400 hover:text-neutral-100"
						onClick={() => setCameraOn((was) => !was)}
						aria-label={
							cameraOn
								? t("teleprompter.cameraOff", "Hide camera")
								: t("teleprompter.cameraOn", "Show camera")
						}
					>
						{cameraOn ? (
							<VideoCameraIcon size={13} weight="bold" />
						) : (
							<VideoCameraSlashIcon size={13} weight="bold" />
						)}
					</Button>
					{!editing && (
						<Button
							variant="ghost"
							size="icon"
							className="h-6 w-6 text-neutral-400 hover:text-neutral-100"
							onClick={backToEdit}
							aria-label={t("teleprompter.edit", "Edit")}
						>
							<PencilSimpleIcon size={13} weight="bold" />
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6 text-neutral-400 hover:text-neutral-100"
						onClick={() => window.electronAPI?.teleprompterClose?.()}
						aria-label={t("teleprompter.close", "Close")}
					>
						<XIcon size={13} weight="bold" />
					</Button>
				</div>
			</header>

			{editing ? (
				<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
					<textarea
						className="min-h-0 flex-1 resize-none rounded-md border border-white/10 bg-black/30 p-3 text-sm leading-relaxed text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-white/25"
						value={script}
						onChange={(event) => setScript(event.target.value)}
						placeholder={t(
							"teleprompter.scriptPlaceholder",
							"Paste or type your script here…",
						)}
						autoFocus
					/>
					<Button
						className="shrink-0"
						onClick={startReading}
						disabled={script.trim().length === 0}
					>
						{t("teleprompter.startReading", "Start reading")}
					</Button>
				</div>
			) : (
				<>
					<div className="relative min-h-0 flex-1">
						<NativeTeleprompterCameraPreview
							cameraOn={cameraOn}
							onPreviewIssueChange={setNativePreviewIssue}
							opacity={cameraOpacity}
							recordingActive={recordingActive}
						/>
						{cameraOn && !nativePreviewActive && !nativePreviewPreferred && (
							<video
								ref={cameraVideoRef}
								autoPlay
								muted
								playsInline
								className="pointer-events-none absolute inset-0 h-full w-full object-cover"
								style={{ transform: "scaleX(-1)", opacity: cameraOpacity }}
							/>
						)}
						<div
							ref={scrollContainerRef}
							className="absolute inset-0 overflow-y-auto px-5"
							onWheel={handleWheel}
							onScroll={handleScroll}
						>
							<div
								className="whitespace-pre-wrap pt-6 pb-[70vh] font-medium leading-relaxed"
								style={{
									fontSize: FONT_SIZES[fontIndex],
									textShadow: cameraOn
										? "0 1px 6px rgba(0, 0, 0, 0.9)"
										: undefined,
								}}
							>
								{script}
							</div>
						</div>
					</div>
					<footer className="flex h-10 shrink-0 items-center justify-center gap-1 border-t border-white/10 px-2">
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 text-neutral-300"
							onClick={() =>
								setSpeedIndex((index) => stepIndex(index, -1, SPEED_LEVELS.length))
							}
							aria-label={t("teleprompter.slower", "Slower")}
						>
							<CaretDownIcon size={14} weight="bold" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8 text-neutral-100"
							onClick={togglePlay}
							aria-label={
								playing
									? t("teleprompter.pause", "Pause")
									: t("teleprompter.play", "Play")
							}
						>
							{playing ? (
								<PauseIcon size={16} weight="fill" />
							) : (
								<PlayIcon size={16} weight="fill" />
							)}
						</Button>
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 text-neutral-300"
							onClick={() =>
								setSpeedIndex((index) => stepIndex(index, 1, SPEED_LEVELS.length))
							}
							aria-label={t("teleprompter.faster", "Faster")}
						>
							<CaretUpIcon size={14} weight="bold" />
						</Button>
						<span className="w-10 select-none text-center text-[10px] tabular-nums text-neutral-500">
							{SPEED_LEVELS[speedIndex]}px/s
						</span>
						<div className="mx-1 h-5 w-px bg-white/10" />
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 text-neutral-300"
							onClick={() =>
								setFontIndex((index) => stepIndex(index, -1, FONT_SIZES.length))
							}
							aria-label={t("teleprompter.smallerText", "Smaller text")}
						>
							<MinusIcon size={14} weight="bold" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7 text-neutral-300"
							onClick={() =>
								setFontIndex((index) => stepIndex(index, 1, FONT_SIZES.length))
							}
							aria-label={t("teleprompter.biggerText", "Bigger text")}
						>
							<PlusIcon size={14} weight="bold" />
						</Button>
						{cameraOn && (
							<>
								<div className="mx-1 h-5 w-px bg-white/10" />
								<Slider
									value={[cameraOpacity]}
									onValueChange={([value]) =>
										setCameraOpacity(clampCameraOpacity(value))
									}
									min={CAMERA_OPACITY_MIN}
									max={CAMERA_OPACITY_MAX}
									step={0.05}
									className="w-20"
									aria-label={t("teleprompter.cameraFade", "Camera fade")}
								/>
							</>
						)}
					</footer>
				</>
			)}
		</div>
	);
}

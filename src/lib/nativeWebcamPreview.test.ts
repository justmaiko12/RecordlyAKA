import { describe, expect, it } from "vitest";
import {
	blankNativeWebcamPreviewImageDisplay,
	buildNativeWebcamPreviewProbeUrl,
	commitNativeWebcamPreviewImageAssignment,
	completeNativeWebcamPreviewImageLoad,
	createInitialNativeWebcamPreviewState,
	createInitialNativeWebcamPreviewImagePumpState,
	expireNativeWebcamPreviewFrame,
	failNativeWebcamPreviewImageLoad,
	getNativeWebcamPreviewExpiryDelay,
	hasNativeWebcamPreviewMountStateChanged,
	hasNativeWebcamPreviewRenderStateChanged,
	isNativeWebcamPreviewFresh,
	isNativeWebcamPreviewVisibleLoadStale,
	NATIVE_WEBCAM_PREVIEW_STALE_MS,
	queueNativeWebcamPreviewImageFrame,
	reduceNativeWebcamPreviewEvent,
	selectNativeWebcamPreviewImageAssignment,
	selectNativeWebcamPreviewDisplayUrl,
	selectNativeWebcamPreviewStreamDisplayUrl,
	shouldRequestNativeWebcamPreviewProbe,
	updateNativeWebcamPreviewVisibleCadence,
} from "./nativeWebcamPreview";

describe("isNativeWebcamPreviewFresh", () => {
	it("expires native proof-preview frames instead of holding stale camera images", () => {
		expect(isNativeWebcamPreviewFresh(10_000, 10_000)).toBe(true);
		expect(
			isNativeWebcamPreviewFresh(10_000, 10_000 - NATIVE_WEBCAM_PREVIEW_STALE_MS + 1),
		).toBe(true);
		expect(isNativeWebcamPreviewFresh(10_000, 10_000 - NATIVE_WEBCAM_PREVIEW_STALE_MS)).toBe(
			false,
		);
		expect(isNativeWebcamPreviewFresh(10_000, null)).toBe(false);
		expect(isNativeWebcamPreviewFresh(Number.NaN, 10_000)).toBe(false);
	});
});

describe("reduceNativeWebcamPreviewEvent", () => {
	it("keeps native preview active but blank while waiting for the first accepted frame", () => {
		const next = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "starting",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			},
			1_000,
		);

		expect(next).toEqual({
			active: true,
			url: null,
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: null,
			stale: false,
		});
		expect(selectNativeWebcamPreviewDisplayUrl(next)).toBeNull();
	});

	it("does not treat one-off frame URLs as displayable live preview", () => {
		const next = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/video?seq=4",
				updatedAt: 4_000,
			},
			5_000,
		);

		expect(next).toEqual({
			active: true,
			url: null,
			streamUrl: null,
			lastFrameAtMs: null,
			stale: false,
		});
	});

	it("uses latest accepted proof-frame URLs after stream ownership is established", () => {
		const starting = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "starting",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			},
			1_000,
		);
		const next = reduceNativeWebcamPreviewEvent(
			starting,
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/video?seq=4",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 4_000,
			},
			5_000,
		);

		expect(next).toEqual({
			active: true,
			url: "http://127.0.0.1/video?seq=4",
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: 4_000,
			stale: false,
		});
	});

	it("displays the latest accepted proof snapshot instead of a queued MJPEG stream", () => {
		const state = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 4_000,
			},
			5_000,
		);

		expect(state.url).toBe("http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4");
		expect(selectNativeWebcamPreviewDisplayUrl(state)).toBe(
			"http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4",
		);
	});

	it("does not fall back to the MJPEG stream when no accepted proof snapshot exists", () => {
		const state = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 4_000,
			},
			5_000,
		);

		expect(state.streamUrl).toBe("http://127.0.0.1/mjpeg-preview?streamId=abc");
		expect(state.url).toBeNull();
		expect(selectNativeWebcamPreviewDisplayUrl(state)).toBeNull();
	});

	it("does not use the MJPEG stream as the visible display after proof exists", () => {
		const state = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 4_000,
			},
			5_000,
		);

		expect(selectNativeWebcamPreviewDisplayUrl(state)).toBe(
			"http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4",
		);
		expect(
			selectNativeWebcamPreviewDisplayUrl(
				expireNativeWebcamPreviewFrame(state, 4_000 + NATIVE_WEBCAM_PREVIEW_STALE_MS),
			),
		).toBeNull();
	});

	it("can expose the MJPEG stream for low-latency teleprompter display only after proof exists", () => {
		const waitingForProof = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "starting",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			},
			1_000,
		);
		expect(selectNativeWebcamPreviewStreamDisplayUrl(waitingForProof)).toBeNull();

		const active = reduceNativeWebcamPreviewEvent(
			waitingForProof,
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 4_000,
			},
			5_000,
		);
		expect(selectNativeWebcamPreviewStreamDisplayUrl(active)).toBe(
			"http://127.0.0.1/mjpeg-preview?streamId=abc",
		);
		expect(
			selectNativeWebcamPreviewStreamDisplayUrl(
				expireNativeWebcamPreviewFrame(active, 4_000 + NATIVE_WEBCAM_PREVIEW_STALE_MS),
			),
		).toBeNull();
	});

	it("does not expose the MJPEG stream when a frame event has no accepted proof snapshot", () => {
		const state = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 4_000,
			},
			5_000,
		);

		expect(state.url).toBeNull();
		expect(selectNativeWebcamPreviewStreamDisplayUrl(state)).toBeNull();
	});

	it("keeps using latest proof-frame URLs when later events omit the stable stream URL", () => {
		const active = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/video?seq=4",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 4_000,
			},
			5_000,
		);
		const next = reduceNativeWebcamPreviewEvent(
			active,
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/video?seq=5",
				updatedAt: 4_033,
			},
			5_033,
		);

		expect(next).toEqual({
			active: true,
			url: "http://127.0.0.1/video?seq=5",
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: 4_033,
			stale: false,
		});
	});

	it("clears the proof preview on stop instead of keeping the last frame", () => {
		const active = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 1_000,
			},
			1_000,
		);

		expect(
			reduceNativeWebcamPreviewEvent(active, { active: false, status: "stopped" }, 1_500),
		).toEqual(createInitialNativeWebcamPreviewState());
	});
});

describe("expireNativeWebcamPreviewFrame", () => {
	it("blanks stale accepted-frame previews while keeping native ownership active", () => {
		const active = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=1",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 2_000,
			},
			2_000,
		);

		expect(
			expireNativeWebcamPreviewFrame(active, 2_000 + NATIVE_WEBCAM_PREVIEW_STALE_MS),
		).toEqual({
			active: true,
			url: null,
			streamUrl: null,
			lastFrameAtMs: 2_000,
			stale: true,
		});
		expect(
			selectNativeWebcamPreviewDisplayUrl(
				expireNativeWebcamPreviewFrame(active, 2_000 + NATIVE_WEBCAM_PREVIEW_STALE_MS),
			),
		).toBeNull();
	});
});

describe("getNativeWebcamPreviewExpiryDelay", () => {
	it("returns the delay until the current accepted-frame preview becomes stale", () => {
		const active = reduceNativeWebcamPreviewEvent(
			createInitialNativeWebcamPreviewState(),
			{
				active: true,
				status: "frame",
				url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=1",
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
				updatedAt: 2_000,
			},
			2_000,
		);

		expect(getNativeWebcamPreviewExpiryDelay(active, 2_500)).toBe(
			NATIVE_WEBCAM_PREVIEW_STALE_MS - 500,
		);
		expect(
			getNativeWebcamPreviewExpiryDelay(createInitialNativeWebcamPreviewState(), 2_500),
		).toBe(null);
	});
});

describe("isNativeWebcamPreviewVisibleLoadStale", () => {
	it("does not report stale visible preview before a display URL starts", () => {
		expect(
			isNativeWebcamPreviewVisibleLoadStale({
				nowMs: 5_000,
				previewUrl: null,
				visibleStartedAtMs: 3_000,
				lastVisibleLoadAtMs: null,
			}),
		).toBe(false);
		expect(
			isNativeWebcamPreviewVisibleLoadStale({
				nowMs: 5_000,
				previewUrl: "http://127.0.0.1/frame.jpg",
				visibleStartedAtMs: null,
				lastVisibleLoadAtMs: null,
			}),
		).toBe(false);
	});

	it("reports stale visible preview when the image element stops loading accepted frames", () => {
		expect(
			isNativeWebcamPreviewVisibleLoadStale({
				nowMs: 5_000,
				previewUrl: "http://127.0.0.1/frame.jpg",
				visibleStartedAtMs: 3_000,
				lastVisibleLoadAtMs: null,
				timeoutMs: 2_000,
			}),
		).toBe(true);
		expect(
			isNativeWebcamPreviewVisibleLoadStale({
				nowMs: 5_000,
				previewUrl: "http://127.0.0.1/frame.jpg",
				visibleStartedAtMs: 1_000,
				lastVisibleLoadAtMs: 3_001,
				timeoutMs: 2_000,
			}),
		).toBe(false);
		expect(
			isNativeWebcamPreviewVisibleLoadStale({
				nowMs: 5_000,
				previewUrl: "http://127.0.0.1/frame.jpg",
				visibleStartedAtMs: 1_000,
				lastVisibleLoadAtMs: 3_000,
				timeoutMs: 2_000,
			}),
		).toBe(true);
	});
});

describe("native webcam preview delivery probes", () => {
	it("throttles snapshot probes while accepted proof frames keep arriving", () => {
		expect(
			shouldRequestNativeWebcamPreviewProbe({
				nowMs: 5_000,
				lastProbeRequestedAtMs: null,
				snapshotUrl: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=1",
			}),
		).toBe(true);
		expect(
			shouldRequestNativeWebcamPreviewProbe({
				nowMs: 5_500,
				lastProbeRequestedAtMs: 5_000,
				snapshotUrl: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=2",
			}),
		).toBe(false);
		expect(
			shouldRequestNativeWebcamPreviewProbe({
				nowMs: 6_000,
				lastProbeRequestedAtMs: 5_000,
				snapshotUrl: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=3",
			}),
		).toBe(true);
		expect(
			shouldRequestNativeWebcamPreviewProbe({
				nowMs: 6_000,
				lastProbeRequestedAtMs: 5_000,
				snapshotUrl: null,
			}),
		).toBe(false);
	});

	it("adds a cache-busting probe parameter to accepted snapshot URLs", () => {
		expect(
			buildNativeWebcamPreviewProbeUrl(
				"http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=3",
				6_000,
			),
		).toBe("http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=3&probe=6000");
		expect(buildNativeWebcamPreviewProbeUrl("http://127.0.0.1/frame.jpg", 6_000)).toBe(
			"http://127.0.0.1/frame.jpg?probe=6000",
		);
	});
});

describe("native webcam preview image pump", () => {
	it("drops older pending snapshots while an image load is in flight", () => {
		const initial = createInitialNativeWebcamPreviewImagePumpState();
		const queuedFirst = queueNativeWebcamPreviewImageFrame(initial, "frame-1.jpg");

		expect(selectNativeWebcamPreviewImageAssignment(queuedFirst, 1_000, 33)).toEqual({
			action: "assign",
			url: "frame-1.jpg",
		});

		const assignedFirst = commitNativeWebcamPreviewImageAssignment(
			queuedFirst,
			"frame-1.jpg",
			1_000,
		);
		const queuedSecond = queueNativeWebcamPreviewImageFrame(assignedFirst, "frame-2.jpg");
		const queuedThird = queueNativeWebcamPreviewImageFrame(queuedSecond, "frame-3.jpg");

		expect(selectNativeWebcamPreviewImageAssignment(queuedThird, 1_010, 33)).toEqual({
			action: "wait",
			delayMs: null,
		});

		const completedFirst = completeNativeWebcamPreviewImageLoad(
			queuedThird,
			"frame-1.jpg",
		);

		expect(completedFirst.accepted).toBe(true);
		expect(selectNativeWebcamPreviewImageAssignment(completedFirst.state, 1_033, 33)).toEqual({
			action: "assign",
			url: "frame-3.jpg",
		});
	});

	it("rate limits assignments even when the image element loads immediately", () => {
		const queuedFirst = queueNativeWebcamPreviewImageFrame(
			createInitialNativeWebcamPreviewImagePumpState(),
			"frame-1.jpg",
		);
		const assignedFirst = commitNativeWebcamPreviewImageAssignment(
			queuedFirst,
			"frame-1.jpg",
			1_000,
		);
		const completedFirst = completeNativeWebcamPreviewImageLoad(
			assignedFirst,
			"frame-1.jpg",
		).state;
		const queuedSecond = queueNativeWebcamPreviewImageFrame(completedFirst, "frame-2.jpg");

		expect(selectNativeWebcamPreviewImageAssignment(queuedSecond, 1_010, 33)).toEqual({
			action: "wait",
			delayMs: 23,
		});
		expect(selectNativeWebcamPreviewImageAssignment(queuedSecond, 1_033, 33)).toEqual({
			action: "assign",
			url: "frame-2.jpg",
		});
	});

	it("does not accept stale load events as proof that the visible preview is current", () => {
		const queuedFirst = queueNativeWebcamPreviewImageFrame(
			createInitialNativeWebcamPreviewImagePumpState(),
			"frame-1.jpg",
		);
		const assignedFirst = commitNativeWebcamPreviewImageAssignment(
			queuedFirst,
			"frame-1.jpg",
			1_000,
		);
		const queuedSecond = queueNativeWebcamPreviewImageFrame(assignedFirst, "frame-2.jpg");
		const errored = failNativeWebcamPreviewImageLoad(queuedSecond);
		const assignedSecond = commitNativeWebcamPreviewImageAssignment(
			errored,
			"frame-2.jpg",
			1_040,
		);
		const staleLoad = completeNativeWebcamPreviewImageLoad(assignedSecond, "frame-1.jpg");

		expect(staleLoad.accepted).toBe(false);
		expect(staleLoad.state.loadInFlight).toBe(true);
		expect(staleLoad.state.activeUrl).toBe("frame-2.jpg");
	});

	it("preempts a slow visible image load and skips to the newest pending snapshot", () => {
		const queuedFirst = queueNativeWebcamPreviewImageFrame(
			createInitialNativeWebcamPreviewImagePumpState(),
			"frame-1.jpg",
		);
		const assignedFirst = commitNativeWebcamPreviewImageAssignment(
			queuedFirst,
			"frame-1.jpg",
			1_000,
		);
		const queuedSecond = queueNativeWebcamPreviewImageFrame(assignedFirst, "frame-2.jpg");
		const queuedLatest = queueNativeWebcamPreviewImageFrame(queuedSecond, "frame-9.jpg");

		expect(selectNativeWebcamPreviewImageAssignment(queuedLatest, 1_100, 33, 120)).toEqual({
			action: "wait",
			delayMs: null,
		});
		expect(selectNativeWebcamPreviewImageAssignment(queuedLatest, 1_120, 33, 120)).toEqual({
			action: "assign",
			url: "frame-9.jpg",
		});
	});

	it("blanks stale visible preview without discarding the newest pending frame", () => {
		const queuedFirst = queueNativeWebcamPreviewImageFrame(
			createInitialNativeWebcamPreviewImagePumpState(),
			"frame-1.jpg",
		);
		const assignedFirst = commitNativeWebcamPreviewImageAssignment(
			queuedFirst,
			"frame-1.jpg",
			1_000,
		);
		const queuedLatest = queueNativeWebcamPreviewImageFrame(assignedFirst, "frame-9.jpg");
		const blanked = blankNativeWebcamPreviewImageDisplay(queuedLatest);

		expect(blanked).toMatchObject({
			activeUrl: null,
			pendingUrl: "frame-9.jpg",
			loadInFlight: false,
		});
		expect(selectNativeWebcamPreviewImageAssignment(blanked, 1_033, 33)).toEqual({
			action: "assign",
			url: "frame-9.jpg",
		});
	});
});

describe("hasNativeWebcamPreviewRenderStateChanged", () => {
	it("rerenders visible preview when the accepted proof snapshot advances", () => {
		const previous = {
			active: true,
			url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4",
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: 4_000,
			stale: false,
		};
		const next = {
			active: true,
			url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=5",
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: 4_033,
			stale: false,
		};

		expect(hasNativeWebcamPreviewRenderStateChanged(previous, next)).toBe(true);
	});

	it("rerenders when the displayed proof preview expires, not for stream-only churn", () => {
		const active = {
			active: true,
			url: null,
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: 4_000,
			stale: false,
		};

		expect(
			hasNativeWebcamPreviewRenderStateChanged(active, {
				...active,
				stale: true,
				streamUrl: null,
			}),
		).toBe(true);
		expect(
			hasNativeWebcamPreviewRenderStateChanged(active, {
				...active,
				streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=def",
			}),
		).toBe(false);
	});
});

describe("updateNativeWebcamPreviewVisibleCadence", () => {
	it("marks recording preview as low-cadence when visible loads fall below the threshold", () => {
		const cadence = updateNativeWebcamPreviewVisibleCadence({
			previousLoadTimes: [1_000, 2_000, 3_000],
			nowMs: 4_000,
			recordingActive: true,
			windowMs: 3_000,
			minFps: 12,
		});

		expect(cadence.loadTimes).toEqual([1_000, 2_000, 3_000, 4_000]);
		expect(cadence.visibleFps).toBeCloseTo(1, 3);
		expect(cadence.windowMs).toBe(3_000);
		expect(cadence.lowCadence).toBe(true);
	});

	it("does not report low cadence before enough visible time has been measured", () => {
		const cadence = updateNativeWebcamPreviewVisibleCadence({
			previousLoadTimes: [1_000],
			nowMs: 1_100,
			recordingActive: true,
			windowMs: 3_000,
			minFps: 12,
		});

		expect(cadence.visibleFps).toBeCloseTo(10, 3);
		expect(cadence.windowMs).toBe(100);
		expect(cadence.lowCadence).toBe(false);
	});

	it("keeps low-cadence preview warnings scoped to active recordings", () => {
		const cadence = updateNativeWebcamPreviewVisibleCadence({
			previousLoadTimes: [1_000, 2_000, 3_000],
			nowMs: 4_000,
			recordingActive: false,
			windowMs: 3_000,
			minFps: 12,
		});

		expect(cadence.lowCadence).toBe(false);
	});
});

describe("hasNativeWebcamPreviewMountStateChanged", () => {
	it("does not rerender teleprompter preview for every proof snapshot once the image is mounted", () => {
		const previous = {
			active: true,
			url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=4",
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: 4_000,
			stale: false,
		};
		const next = {
			...previous,
			url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=5",
			lastFrameAtMs: 4_033,
		};

		expect(hasNativeWebcamPreviewRenderStateChanged(previous, next)).toBe(true);
		expect(hasNativeWebcamPreviewMountStateChanged(previous, next)).toBe(false);
	});

	it("rerenders teleprompter preview when proof display starts or expires", () => {
		const waitingForProof = {
			active: true,
			url: null,
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: null,
			stale: false,
		};
		const active = {
			active: true,
			url: "http://127.0.0.1/mjpeg-preview-snapshot?streamId=abc&seq=1",
			streamUrl: "http://127.0.0.1/mjpeg-preview?streamId=abc",
			lastFrameAtMs: 4_000,
			stale: false,
		};

		expect(hasNativeWebcamPreviewMountStateChanged(waitingForProof, active)).toBe(true);
		expect(
			hasNativeWebcamPreviewMountStateChanged(active, {
				...active,
				url: null,
				streamUrl: null,
				stale: true,
			}),
		).toBe(true);
	});
});

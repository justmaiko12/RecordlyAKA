import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/extensions", () => ({
	extensionHost: {
		emitEvent: vi.fn(),
	},
}));

import { extensionHost } from "@/lib/extensions";
import { createVideoEventHandlers } from "./videoEventHandlers";

type PresentedFrameCallback = (now: DOMHighResTimeStamp, metadata: { mediaTime?: number }) => void;

type MockVideo = HTMLVideoElement & {
	requestVideoFrameCallback?: (callback: PresentedFrameCallback) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

function createMutableRef<T>(value: T) {
	return { current: value };
}

function createMockVideo(overrides: Partial<MockVideo> = {}): MockVideo {
	const video = {
		currentTime: 0.5,
		duration: 10,
		paused: false,
		ended: false,
		playbackRate: 1,
		pause: vi.fn(),
	} as unknown as MockVideo;

	return Object.assign(video, overrides);
}

describe("createVideoEventHandlers", () => {
	const emitEventMock = vi.mocked(extensionHost.emitEvent);
	let requestAnimationFrameMock: ReturnType<typeof vi.fn>;
	let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		requestAnimationFrameMock = vi.fn(() => 11);
		cancelAnimationFrameMock = vi.fn();
		vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
		vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);
		emitEventMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("prefers requestVideoFrameCallback mediaTime when available", () => {
		let presentedFrameCallback: PresentedFrameCallback | null = null;
		const video = createMockVideo({
			requestVideoFrameCallback: vi.fn((callback) => {
				presentedFrameCallback = callback;
				return 7;
			}),
			cancelVideoFrameCallback: vi.fn(),
		});
		const onPlayStateChange = vi.fn();
		const onTimeUpdate = vi.fn();
		const currentTimeRef = createMutableRef(0);
		const timeUpdateAnimationRef = createMutableRef<number | null>(null);

		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef,
			timeUpdateAnimationRef,
			onPlayStateChange,
			onTimeUpdate,
			trimRegionsRef: createMutableRef([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		expect(onPlayStateChange).toHaveBeenCalledWith(true);
		expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
		expect(requestAnimationFrameMock).not.toHaveBeenCalled();

		presentedFrameCallback?.(0, { mediaTime: 1.25 });

		expect(onTimeUpdate).toHaveBeenCalledWith(1.25);
		expect(currentTimeRef.current).toBe(1250);
		expect(emitEventMock).toHaveBeenLastCalledWith({
			type: "playback:timeupdate",
			timeMs: 1250,
		});
	});

	it("falls back to requestAnimationFrame when requestVideoFrameCallback is unavailable", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 19;
		});
		const video = createMockVideo({ currentTime: 0.75 });
		const onTimeUpdate = vi.fn();

		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

		video.paused = true;
		animationFrameCallback?.(0);

		expect(onTimeUpdate).toHaveBeenCalledWith(0.75);
	});

	it("skips removed footage when playback reaches a cut region", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 29;
		});
		const video = createMockVideo({ currentTime: 1.25, duration: 10 });
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([{ id: "trim-1", startMs: 1000, endMs: 2000 }]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		animationFrameCallback?.(0);

		expect(video.currentTime).toBe(2);
		expect(video.pause).not.toHaveBeenCalled();
		expect(onTimeUpdate).toHaveBeenLastCalledWith(2);
	});

	it("cancels a pending requestVideoFrameCallback on pause and dispose", () => {
		const cancelVideoFrameCallback = vi.fn();
		const video = createMockVideo({
			requestVideoFrameCallback: vi.fn(() => 23),
			cancelVideoFrameCallback,
		});
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate: vi.fn(),
			trimRegionsRef: createMutableRef([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		handlers.handlePause();
		expect(cancelVideoFrameCallback).toHaveBeenCalledWith(23);

		cancelVideoFrameCallback.mockClear();
		handlers.handlePlay();
		handlers.dispose();
		expect(cancelVideoFrameCallback).toHaveBeenCalledWith(23);
	});

	function createSeekTrackingVideo({ duration = 20 }: { duration?: number } = {}) {
		let backingTime = 0;
		const assignedTimes: number[] = [];
		let frameCallback: PresentedFrameCallback | null = null;
		const video = {
			duration,
			paused: false,
			ended: false,
			playbackRate: 1,
			pause: vi.fn(),
			requestVideoFrameCallback: vi.fn((callback: PresentedFrameCallback) => {
				frameCallback = callback;
				return 31;
			}),
			cancelVideoFrameCallback: vi.fn(),
		} as unknown as MockVideo;
		Object.defineProperty(video, "currentTime", {
			get: () => backingTime,
			set: (value: number) => {
				assignedTimes.push(value);
				backingTime = value;
			},
		});

		return {
			video,
			assignedTimes,
			fireFrame: (mediaTime: number) => frameCallback?.(0, { mediaTime }),
			setCurrentTimeSilently: (value: number) => {
				backingTime = value;
			},
		};
	}

	function createTrimGuardHandlers(
		video: MockVideo,
		trimRegions: { id: string; startMs: number; endMs: number }[],
	) {
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef(trimRegions),
			speedRegionsRef: createMutableRef([]),
		});
		return { handlers, onTimeUpdate };
	}

	describe("trim skip re-entry guard", () => {
		it("does not re-skip the same trim region from a stale frame callback", () => {
			const { video, assignedTimes, fireFrame } = createSeekTrackingVideo();
			const { handlers, onTimeUpdate } = createTrimGuardHandlers(video, [
				{ id: "trim-1", startMs: 5000, endMs: 9000 },
			]);

			handlers.handlePlay();
			fireFrame(5.2);

			expect(assignedTimes).toEqual([9]);
			expect(onTimeUpdate).toHaveBeenLastCalledWith(9);

			// A late frame callback still reporting the pre-seek media time must
			// not trigger a second seek or move the playhead backwards.
			fireFrame(5.2);

			expect(assignedTimes).toEqual([9]);
			expect(onTimeUpdate).toHaveBeenLastCalledWith(9);
		});

		it("clears the pending skip once playback passes the target", () => {
			const { video, assignedTimes, fireFrame } = createSeekTrackingVideo();
			const { handlers, onTimeUpdate } = createTrimGuardHandlers(video, [
				{ id: "trim-1", startMs: 5000, endMs: 9000 },
				{ id: "trim-2", startMs: 12000, endMs: 15000 },
			]);

			handlers.handlePlay();
			fireFrame(5.2);
			fireFrame(5.2); // stale, ignored
			fireFrame(9.0); // reaches the target -> pending state clears

			expect(onTimeUpdate).toHaveBeenLastCalledWith(9);

			// With the pending state cleared, entering the next trim region
			// must trigger a fresh skip.
			fireFrame(12.5);

			expect(assignedTimes).toEqual([9, 15]);
			expect(onTimeUpdate).toHaveBeenLastCalledWith(15);
		});

		it("user scrubbing into a trim region still skips once", () => {
			const { video, assignedTimes, setCurrentTimeSilently } = createSeekTrackingVideo();
			video.paused = true;
			const { handlers, onTimeUpdate } = createTrimGuardHandlers(video, [
				{ id: "trim-1", startMs: 5000, endMs: 9000 },
			]);

			// User scrubs to 6.0s (external currentTime assignment).
			setCurrentTimeSilently(6.0);
			handlers.handleSeeking();
			handlers.handleSeeked();

			expect(assignedTimes).toEqual([9]);

			// Our own corrective seek fires seeking/seeked again in a real
			// browser; it must not seek a second time.
			handlers.handleSeeking();
			handlers.handleSeeked();

			expect(assignedTimes).toEqual([9]);
			expect(onTimeUpdate).toHaveBeenLastCalledWith(9);
		});

		it("a user scrub away from the pending target clears the guard", () => {
			const { video, assignedTimes, fireFrame, setCurrentTimeSilently } =
				createSeekTrackingVideo();
			const { handlers, onTimeUpdate } = createTrimGuardHandlers(video, [
				{ id: "trim-1", startMs: 5000, endMs: 9000 },
			]);

			handlers.handlePlay();
			fireFrame(5.2);
			expect(assignedTimes).toEqual([9]);

			// User scrubs back to 2.0s before playback reaches the target.
			setCurrentTimeSilently(2.0);
			handlers.handleSeeking();
			handlers.handleSeeked();

			expect(assignedTimes).toEqual([9]);
			expect(onTimeUpdate).toHaveBeenLastCalledWith(2);

			// Re-entering the trim region after the scrub must skip again.
			fireFrame(5.5);

			expect(assignedTimes).toEqual([9, 9]);
			expect(onTimeUpdate).toHaveBeenLastCalledWith(9);
		});
	});

	it("skips removed footage after a paused seek", () => {
		const video = createMockVideo({
			currentTime: 1.25,
			paused: true,
		});
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(true),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([{ id: "trim-1", startMs: 1000, endMs: 2000 }]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handleSeeked();

		expect(video.currentTime).toBe(2);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(2);
	});
});

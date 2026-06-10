import type React from "react";
import { extensionHost } from "@/lib/extensions";
import { enablePitchPreservingPlayback } from "@/lib/mediaTiming";
import type { SpeedRegion, TrimRegion } from "../types";

interface PresentedFrameMetadata {
	mediaTime?: number;
}

type PresentedFrameVideoElement = HTMLVideoElement & {
	requestVideoFrameCallback?: (
		callback: (now: DOMHighResTimeStamp, metadata: PresentedFrameMetadata) => void,
	) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

interface VideoEventHandlersParams {
	video: HTMLVideoElement;
	isSeekingRef: React.MutableRefObject<boolean>;
	isPlayingRef: React.MutableRefObject<boolean>;
	allowPlaybackRef: React.MutableRefObject<boolean>;
	currentTimeRef: React.MutableRefObject<number>;
	timeUpdateAnimationRef: React.MutableRefObject<number | null>;
	onPlayStateChange: (playing: boolean) => void;
	onTimeUpdate: (time: number) => void;
	trimRegionsRef: React.MutableRefObject<TrimRegion[]>;
	speedRegionsRef: React.MutableRefObject<SpeedRegion[]>;
}

export function createVideoEventHandlers(params: VideoEventHandlersParams) {
	const {
		video,
		isSeekingRef,
		isPlayingRef,
		allowPlaybackRef,
		currentTimeRef,
		timeUpdateAnimationRef,
		onPlayStateChange,
		onTimeUpdate,
		trimRegionsRef,
		speedRegionsRef,
	} = params;
	const presentedFrameVideo = video as PresentedFrameVideoElement;
	let videoFrameRequestId: number | null = null;
	// While a trim-region skip seek is in flight, frame callbacks can still
	// report pre-seek media times. Tracking the seek target lets us ignore
	// those stale observations instead of re-triggering the seek (which caused
	// a skip -> replay loop with a frozen playhead).
	let pendingTrimSkipTargetMs: number | null = null;
	const PENDING_SKIP_EPSILON_MS = 1;
	const USER_SEEK_CLEAR_THRESHOLD_MS = 50;
	enablePitchPreservingPlayback(video);

	const emitTime = (timeValue: number) => {
		currentTimeRef.current = timeValue * 1000;
		onTimeUpdate(timeValue);
		extensionHost.emitEvent({ type: "playback:timeupdate", timeMs: timeValue * 1000 });
	};

	// Helper function to check if current time is within a trim region
	const findActiveTrimRegion = (currentTimeMs: number): TrimRegion | null => {
		const trimRegions = trimRegionsRef.current;
		return (
			trimRegions.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	};

	// Helper function to find the active speed region at the current time
	const findActiveSpeedRegion = (currentTimeMs: number): SpeedRegion | null => {
		return (
			speedRegionsRef.current.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	};

	// Returns true when the observed time is a stale pre-seek observation that
	// must be ignored; clears the pending target once playback reaches it.
	const isStaleObservationWhileSkipPending = (currentTimeMs: number): boolean => {
		if (pendingTrimSkipTargetMs === null) {
			return false;
		}

		if (currentTimeMs < pendingTrimSkipTargetMs - PENDING_SKIP_EPSILON_MS) {
			return true;
		}

		pendingTrimSkipTargetMs = null;
		return false;
	};

	const skipPastTrimRegion = (trimRegion: TrimRegion) => {
		const skipToTime = trimRegion.endMs / 1000;
		const clampedSkipToTime = Math.min(skipToTime, video.duration);

		pendingTrimSkipTargetMs = clampedSkipToTime * 1000;
		video.currentTime = clampedSkipToTime;
		emitTime(clampedSkipToTime);

		if (clampedSkipToTime >= video.duration) {
			video.pause();
		}
	};

	const cancelScheduledUpdate = () => {
		if (timeUpdateAnimationRef.current !== null) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
			timeUpdateAnimationRef.current = null;
		}

		if (
			videoFrameRequestId !== null &&
			typeof presentedFrameVideo.cancelVideoFrameCallback === "function"
		) {
			presentedFrameVideo.cancelVideoFrameCallback(videoFrameRequestId);
			videoFrameRequestId = null;
		}
	};

	const scheduleNextUpdate = () => {
		if (video.paused || video.ended) {
			return;
		}

		// Align editor state with the frame Chromium actually presented instead of
		// polling `currentTime` on a generic animation frame.
		if (typeof presentedFrameVideo.requestVideoFrameCallback === "function") {
			videoFrameRequestId = presentedFrameVideo.requestVideoFrameCallback(
				(_now, metadata) => {
					videoFrameRequestId = null;
					updateTime(metadata);
				},
			);
			return;
		}

		timeUpdateAnimationRef.current = requestAnimationFrame(() => {
			timeUpdateAnimationRef.current = null;
			updateTime();
		});
	};

	function getPresentedTime(metadata?: PresentedFrameMetadata): number {
		const mediaTime = metadata?.mediaTime;
		return Number.isFinite(mediaTime) ? (mediaTime ?? 0) : video.currentTime;
	}

	function updateTime(metadata?: PresentedFrameMetadata) {
		if (!video) return;

		const presentedTime = getPresentedTime(metadata);
		const currentTimeMs = presentedTime * 1000;

		if (isStaleObservationWhileSkipPending(currentTimeMs)) {
			scheduleNextUpdate();
			return;
		}

		const activeTrimRegion = findActiveTrimRegion(currentTimeMs);

		// If we're in a trim region during playback, skip to the end of it
		if (activeTrimRegion && !video.paused && !video.ended) {
			skipPastTrimRegion(activeTrimRegion);
		} else {
			// Apply playback speed from active speed region
			const activeSpeedRegion = findActiveSpeedRegion(currentTimeMs);
			enablePitchPreservingPlayback(video);
			video.playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
			emitTime(presentedTime);
		}

		scheduleNextUpdate();
	}

	const handlePlay = () => {
		if (!allowPlaybackRef.current) {
			video.pause();
			return;
		}

		isPlayingRef.current = true;
		onPlayStateChange(true);
		cancelScheduledUpdate();
		scheduleNextUpdate();
	};

	const handlePause = () => {
		isPlayingRef.current = false;
		onPlayStateChange(false);
		cancelScheduledUpdate();
		emitTime(video.currentTime);
	};

	const handleSeeked = () => {
		isSeekingRef.current = false;

		const currentTimeMs = video.currentTime * 1000;

		if (isStaleObservationWhileSkipPending(currentTimeMs)) {
			return;
		}

		const activeTrimRegion = findActiveTrimRegion(currentTimeMs);

		// Never leave the preview parked on removed footage after a seek.
		if (activeTrimRegion) {
			skipPastTrimRegion(activeTrimRegion);
		} else {
			emitTime(video.currentTime);
		}
	};

	const handleSeeking = () => {
		isSeekingRef.current = true;

		// A seek that targets somewhere other than our pending skip target is
		// user-initiated (scrub) — the in-flight skip no longer applies.
		const currentTimeMs = video.currentTime * 1000;
		if (
			pendingTrimSkipTargetMs !== null &&
			Math.abs(currentTimeMs - pendingTrimSkipTargetMs) > USER_SEEK_CLEAR_THRESHOLD_MS
		) {
			pendingTrimSkipTargetMs = null;
		}

		emitTime(video.currentTime);
	};

	return {
		dispose: cancelScheduledUpdate,
		handlePlay,
		handlePause,
		handleSeeked,
		handleSeeking,
	};
}

import React, { useEffect, useMemo, useState } from "react";
import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import { resolveSourceTrackRoutingPolicy } from "@/lib/exporter/sourceTrackRoutingPolicy";
import type { AudioRegion, ClipRegion, SpeedRegion } from "../types";
import { getActiveClipIdAtSourceTime, isClipMutedById } from "./clipAudio";
import { getSourceAudioPreviewSyncRatio, useAudioPreviewSync } from "./useAudioPreviewSync";
import { useClipAudioSettingsController } from "./useClipAudioSettingsController";
import { useSourceAudioFallback } from "./useSourceAudioFallback";

function extractLocalPathFromMediaServerUrl(input: string | null | undefined): string | null {
	if (!input) return null;
	try {
		const url = new URL(input);
		const isLocalMediaServer =
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
			url.pathname === "/video";
		if (!isLocalMediaServer) return null;
		return url.searchParams.get("path");
	} catch {
		return null;
	}
}

interface UseVideoEditorAudioParams {
	currentSourcePath: string | null;
	selectedClipId: string | null;
	clipRegions: ClipRegion[];
	audioRegions: AudioRegion[];
	effectiveSpeedRegions: SpeedRegion[];
	sourceAudioTrackSettingsByClip: Record<string, SourceAudioTrackSettings>;
	setSourceAudioTrackSettingsByClip: React.Dispatch<
		React.SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	defaultSourceAudioTrackSettings: SourceAudioTrackSettings;
	setDefaultSourceAudioTrackSettings: React.Dispatch<
		React.SetStateAction<SourceAudioTrackSettings>
	>;
	currentTime: number;
	timelineTime: number;
	duration: number;
	isPlaying: boolean;
	previewVolume: number;
	sourceAudioFallbackRefreshKey?: number;
	summarizeErrorMessage: (message: string) => string;
	onSourceFallbackLoadError: (error: unknown) => void;
}

export function shouldMutePreviewVideoAudio({
	muteEmbeddedPreview,
	controlledEmbeddedAudioPreview,
	sourceAudioPreviewPlaybackConfirmed,
}: {
	muteEmbeddedPreview: boolean;
	controlledEmbeddedAudioPreview: boolean;
	sourceAudioPreviewPlaybackConfirmed: boolean;
}) {
	return (
		muteEmbeddedPreview ||
		(controlledEmbeddedAudioPreview && sourceAudioPreviewPlaybackConfirmed)
	);
}

export function useVideoEditorAudio({
	currentSourcePath,
	selectedClipId,
	clipRegions,
	audioRegions,
	effectiveSpeedRegions,
	sourceAudioTrackSettingsByClip,
	setSourceAudioTrackSettingsByClip,
	defaultSourceAudioTrackSettings,
	setDefaultSourceAudioTrackSettings,
	currentTime,
	timelineTime,
	duration,
	isPlaying,
	previewVolume,
	sourceAudioFallbackRefreshKey = 0,
	summarizeErrorMessage,
	onSourceFallbackLoadError,
}: UseVideoEditorAudioParams) {
	const fallbackLookupSourcePath = useMemo(
		() => extractLocalPathFromMediaServerUrl(currentSourcePath) ?? currentSourcePath,
		[currentSourcePath],
	);

	const { sourceAudioFallbackPaths, sourceAudioFallbackStartDelayMsByPath } =
		useSourceAudioFallback({
			currentSourcePath: fallbackLookupSourcePath,
			refreshKey: sourceAudioFallbackRefreshKey,
			summarizeErrorMessage,
		});

	const sourceTrackRoutingPolicy = useMemo(
		() => resolveSourceTrackRoutingPolicy(currentSourcePath, sourceAudioFallbackPaths),
		[currentSourcePath, sourceAudioFallbackPaths],
	);
	const [embeddedAudioDurationSec, setEmbeddedAudioDurationSec] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		setEmbeddedAudioDurationSec(null);

		if (!fallbackLookupSourcePath || !window.electronAPI?.probeNativeVideoMetadata) {
			return () => {
				cancelled = true;
			};
		}

		void window.electronAPI
			.probeNativeVideoMetadata(fallbackLookupSourcePath)
			.then((result) => {
				if (cancelled) {
					return;
				}
				const audioDuration = result.success ? result.metadata?.audioDuration : undefined;
				setEmbeddedAudioDurationSec(
					Number.isFinite(audioDuration) && (audioDuration ?? 0) > 0
						? (audioDuration ?? null)
						: null,
				);
			})
			.catch(() => {
				if (!cancelled) {
					setEmbeddedAudioDurationSec(null);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [fallbackLookupSourcePath]);

	const shouldUseControlledEmbeddedAudioPreview =
		Boolean(fallbackLookupSourcePath) &&
		sourceTrackRoutingPolicy.playbackPaths.length === 0 &&
		getSourceAudioPreviewSyncRatio(duration, embeddedAudioDurationSec) !== 1;
	const previewSourceAudioFallbackPaths = useMemo(() => {
		if (!shouldUseControlledEmbeddedAudioPreview || !fallbackLookupSourcePath) {
			return sourceTrackRoutingPolicy.playbackPaths;
		}

		return Array.from(
			new Set([...sourceTrackRoutingPolicy.playbackPaths, fallbackLookupSourcePath]),
		);
	}, [
		fallbackLookupSourcePath,
		shouldUseControlledEmbeddedAudioPreview,
		sourceTrackRoutingPolicy.playbackPaths,
	]);
	const sourceAudioDurationSecByPath = useMemo(
		() =>
			fallbackLookupSourcePath &&
			Number.isFinite(embeddedAudioDurationSec) &&
			(embeddedAudioDurationSec ?? 0) > 0
				? { [fallbackLookupSourcePath]: embeddedAudioDurationSec ?? 0 }
				: {},
		[embeddedAudioDurationSec, fallbackLookupSourcePath],
	);

	const activeClipIdAtCurrentTime = useMemo(
		() => getActiveClipIdAtSourceTime(currentTime, clipRegions),
		[clipRegions, currentTime],
	);
	const isCurrentClipMuted = useMemo(
		() => isClipMutedById(activeClipIdAtCurrentTime, clipRegions),
		[activeClipIdAtCurrentTime, clipRegions],
	);

	const {
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	} = useClipAudioSettingsController({
		selectedClipId,
		activeClipId: activeClipIdAtCurrentTime,
		sourceAudioTrackSettingsByClip,
		setSourceAudioTrackSettingsByClip,
		defaultSourceAudioTrackSettings,
		setDefaultSourceAudioTrackSettings,
	});

	const { playSourceAudioPreview, sourceAudioPreviewPlaybackConfirmed } = useAudioPreviewSync({
		audioRegions,
		previewVolume,
		isPlaying,
		currentTime,
		timelineTime,
		duration,
		effectiveSpeedRegions,
		previewSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		sourceAudioDurationSecByPath,
		isCurrentClipMuted,
		getSourceTrackPreviewGain,
		onSourceFallbackLoadError,
	});
	const shouldMutePreviewVideo = shouldMutePreviewVideoAudio({
		muteEmbeddedPreview: sourceTrackRoutingPolicy.muteEmbeddedPreview,
		controlledEmbeddedAudioPreview: shouldUseControlledEmbeddedAudioPreview,
		sourceAudioPreviewPlaybackConfirmed,
	});

	return {
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		previewSourceAudioFallbackPaths,
		shouldMutePreviewVideo,
		activeClipIdAtCurrentTime,
		isCurrentClipMuted,
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		playSourceAudioPreview,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	};
}

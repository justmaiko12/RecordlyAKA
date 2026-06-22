import { Pause, Play } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTimelineAudioPeaks } from "./timeline/hooks/useTimelineAudioPeaks";
import type { AudioPeaksData } from "./timeline/core/timelineTypes";
import type { WebcamReplacementSyncMode } from "./webcamReplacementSync";

type AudioMonitorMode = "reference" | "replacement" | "both" | "muted";

export interface WebcamReplacementSyncApplyPayload {
	sourcePath: string;
	timeOffsetMs: number;
	mode: WebcamReplacementSyncMode;
	replacementDurationMs: number | null;
}

interface WebcamReplacementSyncDialogProps {
	open: boolean;
	referenceVideoUrl: string | null;
	replacementVideoUrl: string | null;
	replacementPath: string | null;
	initialReferenceTimeSec: number;
	initialOffsetMs?: number;
	timelineDurationSec: number;
	onCancel: () => void;
	onApply: (payload: WebcamReplacementSyncApplyPayload) => void;
}

function clamp(value: number, min: number, max: number) {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function formatSeconds(value: number) {
	if (!Number.isFinite(value)) return "0.00";
	return value.toFixed(2);
}

function formatOffset(offsetMs: number) {
	return `${offsetMs > 0 ? "+" : ""}${Math.round(offsetMs)}ms`;
}

function getReplacementTargetTimeSec({
	referenceTimeSec,
	offsetMs,
	replacementDurationSec,
}: {
	referenceTimeSec: number;
	offsetMs: number;
	replacementDurationSec: number | null;
}) {
	return clamp(
		referenceTimeSec - offsetMs / 1000,
		0,
		Math.max(0, replacementDurationSec ?? Number.POSITIVE_INFINITY),
	);
}

function SyncWaveform({
	peaks,
	loading,
	currentMs,
	windowDurationMs,
	className,
}: {
	peaks: AudioPeaksData | null;
	loading: boolean;
	currentMs: number;
	windowDurationMs: number;
	className?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [resizeKey, setResizeKey] = useState(0);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const observer = new ResizeObserver(() => setResizeKey((key) => key + 1));
		observer.observe(canvas);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !peaks) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const rect = canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(rect.width * dpr));
		const height = Math.max(1, Math.round(rect.height * dpr));
		canvas.width = width;
		canvas.height = height;

		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "rgba(255,255,255,0.045)";
		ctx.fillRect(0, 0, width, height);

		const visibleDurationMs = Math.max(1000, windowDurationMs);
		const visibleStartMs = currentMs - visibleDurationMs / 2;
		const visibleEndMs = currentMs + visibleDurationMs / 2;
		const midY = height / 2;
		const peakData = peaks.peaks;

		ctx.beginPath();
		for (let px = 0; px < width; px++) {
			const t = visibleStartMs + (px / width) * (visibleEndMs - visibleStartMs);
			if (t < 0 || t > peaks.durationMs || peakData.length === 0) continue;
			const exactIndex = (t / peaks.durationMs) * (peakData.length - 1);
			const leftIndex = Math.floor(exactIndex);
			const rightIndex = Math.min(peakData.length - 1, leftIndex + 1);
			const mix = exactIndex - leftIndex;
			const amplitude = Math.max(
				0,
				Math.min(1, peakData[leftIndex] * (1 - mix) + peakData[rightIndex] * mix),
			);
			const barHeight = amplitude * midY * 0.82;
			ctx.moveTo(px, midY - barHeight);
			ctx.lineTo(px, midY + barHeight);
		}
		ctx.strokeStyle = "rgba(96,165,250,0.82)";
		ctx.lineWidth = Math.max(1, dpr);
		ctx.stroke();

		ctx.fillStyle = "rgba(255,255,255,0.9)";
		const playheadX = width / 2;
		ctx.fillRect(playheadX - dpr, 0, dpr * 2, height);
	}, [currentMs, peaks, resizeKey, windowDurationMs]);

	return (
		<div className={cn("relative h-14 overflow-hidden rounded-md border border-foreground/10 bg-black/25", className)}>
			<canvas ref={canvasRef} className="h-full w-full" />
			{loading ? (
				<div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
					Loading levels...
				</div>
			) : !peaks ? (
				<div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
					No audio levels
				</div>
			) : null}
		</div>
	);
}

export function WebcamReplacementSyncDialog({
	open,
	referenceVideoUrl,
	replacementVideoUrl,
	replacementPath,
	initialReferenceTimeSec,
	initialOffsetMs = 0,
	timelineDurationSec,
	onCancel,
	onApply,
}: WebcamReplacementSyncDialogProps) {
	const referenceVideoRef = useRef<HTMLVideoElement | null>(null);
	const replacementVideoRef = useRef<HTMLVideoElement | null>(null);
	const [referenceTimeSec, setReferenceTimeSec] = useState(initialReferenceTimeSec);
	const [offsetMs, setOffsetMs] = useState(initialOffsetMs);
	const [mode, setMode] = useState<WebcamReplacementSyncMode>("camera-only");
	const [audioMonitor, setAudioMonitor] = useState<AudioMonitorMode>("replacement");
	const [isPlaying, setIsPlaying] = useState(false);
	const [replacementDurationSec, setReplacementDurationSec] = useState<number | null>(null);
	const { peaks: referencePeaks, loading: referencePeaksLoading } =
		useTimelineAudioPeaks(referenceVideoUrl);
	const { peaks: replacementPeaks, loading: replacementPeaksLoading } =
		useTimelineAudioPeaks(replacementVideoUrl);

	useEffect(() => {
		if (!open) return;
		setReferenceTimeSec(clamp(initialReferenceTimeSec, 0, Math.max(0, timelineDurationSec)));
		setOffsetMs(initialOffsetMs);
		setMode("camera-only");
		setAudioMonitor("replacement");
		setIsPlaying(false);
		setReplacementDurationSec(null);
	}, [initialOffsetMs, initialReferenceTimeSec, open, timelineDurationSec]);

	const replacementTimeSec = useMemo(
		() =>
			getReplacementTargetTimeSec({
				referenceTimeSec,
				offsetMs,
				replacementDurationSec,
			}),
		[offsetMs, referenceTimeSec, replacementDurationSec],
	);

	const syncVideoElements = useCallback(() => {
		const reference = referenceVideoRef.current;
		const replacement = replacementVideoRef.current;
		if (reference && Number.isFinite(referenceTimeSec)) {
			reference.currentTime = clamp(referenceTimeSec, 0, reference.duration || timelineDurationSec);
		}
		if (replacement && Number.isFinite(replacementTimeSec)) {
			replacement.currentTime = clamp(
				replacementTimeSec,
				0,
				replacement.duration || replacementDurationSec || replacementTimeSec,
			);
		}
	}, [referenceTimeSec, replacementDurationSec, replacementTimeSec, timelineDurationSec]);

	useEffect(() => {
		if (!open || isPlaying) return;
		syncVideoElements();
	}, [isPlaying, offsetMs, open, referenceTimeSec, syncVideoElements]);

	useEffect(() => {
		const reference = referenceVideoRef.current;
		const replacement = replacementVideoRef.current;
		if (reference) {
			reference.muted = audioMonitor !== "reference" && audioMonitor !== "both";
		}
		if (replacement) {
			replacement.muted = audioMonitor !== "replacement" && audioMonitor !== "both";
		}
	}, [audioMonitor]);

	useEffect(() => {
		if (!open || !isPlaying) return;
		let rafId = 0;
		const tick = () => {
			const reference = referenceVideoRef.current;
			if (reference) {
				setReferenceTimeSec(reference.currentTime);
				const replacement = replacementVideoRef.current;
				if (replacement && Math.abs(replacement.currentTime - replacementTimeSec) > 0.35) {
					replacement.currentTime = replacementTimeSec;
				}
			}
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
	}, [isPlaying, open, replacementTimeSec]);

	const setReferenceTimeFromInput = useCallback(
		(value: number) => {
			const next = clamp(value, 0, Math.max(0, timelineDurationSec));
			setReferenceTimeSec(next);
		},
		[timelineDurationSec],
	);

	const nudgeOffset = useCallback((deltaMs: number) => {
		setOffsetMs((current) => Math.round(current + deltaMs));
	}, []);

	const handlePlayPause = useCallback(async () => {
		const reference = referenceVideoRef.current;
		const replacement = replacementVideoRef.current;
		if (!reference || !replacement) return;

		if (isPlaying) {
			reference.pause();
			replacement.pause();
			setIsPlaying(false);
			return;
		}

		syncVideoElements();
		try {
			await Promise.allSettled([reference.play(), replacement.play()]);
			setIsPlaying(true);
		} catch {
			setIsPlaying(false);
		}
	}, [isPlaying, syncVideoElements]);

	const handleApply = useCallback(() => {
		if (!replacementPath) return;
		const replacementDurationMs =
			Number.isFinite(replacementDurationSec) && (replacementDurationSec ?? 0) > 0
				? Math.round((replacementDurationSec ?? 0) * 1000)
				: replacementPeaks?.durationMs ?? null;
		onApply({
			sourcePath: replacementPath,
			timeOffsetMs: Math.round(offsetMs),
			mode,
			replacementDurationMs,
		});
	}, [mode, offsetMs, onApply, replacementDurationSec, replacementPath, replacementPeaks]);

	const canPreview = Boolean(referenceVideoUrl && replacementVideoUrl);

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
			<DialogContent className="max-w-5xl border-foreground/10 bg-editor-dialog text-foreground">
				<DialogHeader>
					<DialogTitle>Sync replacement camera</DialogTitle>
					<DialogDescription>
						Compare the project clip with the imported camera, line up the levels, then
						choose whether the imported file also becomes an audio track.
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
					<div className="grid min-w-0 gap-3 md:grid-cols-2">
						<div className="min-w-0 rounded-lg border border-foreground/10 bg-black/25 p-2">
							<div className="mb-2 text-xs font-semibold text-muted-foreground">
								Current project
							</div>
							<video
								ref={referenceVideoRef}
								src={referenceVideoUrl ?? undefined}
								className="aspect-video w-full rounded-md bg-black object-contain"
								playsInline
							/>
							<div className="mt-2 text-[11px] text-muted-foreground">
								{formatSeconds(referenceTimeSec)}s
							</div>
							<SyncWaveform
								peaks={referencePeaks}
								loading={referencePeaksLoading}
								currentMs={referenceTimeSec * 1000}
								windowDurationMs={12_000}
								className="mt-2"
							/>
						</div>

						<div className="min-w-0 rounded-lg border border-foreground/10 bg-black/25 p-2">
							<div className="mb-2 text-xs font-semibold text-muted-foreground">
								Replacement camera
							</div>
							<video
								ref={replacementVideoRef}
								src={replacementVideoUrl ?? undefined}
								className="aspect-video w-full rounded-md bg-black object-contain"
								playsInline
								onLoadedMetadata={(event) => {
									const nextDuration = event.currentTarget.duration;
									setReplacementDurationSec(
										Number.isFinite(nextDuration) && nextDuration > 0
											? nextDuration
											: null,
									);
								}}
							/>
							<div className="mt-2 text-[11px] text-muted-foreground">
								{formatSeconds(replacementTimeSec)}s at {formatOffset(offsetMs)}
							</div>
							<SyncWaveform
								peaks={replacementPeaks}
								loading={replacementPeaksLoading}
								currentMs={replacementTimeSec * 1000}
								windowDurationMs={12_000}
								className="mt-2"
							/>
						</div>
					</div>

					<div className="space-y-4 rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3">
						<Button
							type="button"
							onClick={handlePlayPause}
							disabled={!canPreview}
							className="h-9 w-full gap-2 rounded-[5px] bg-[#2563EB] text-white hover:bg-[#2563EB]/92"
						>
							{isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
							{isPlaying ? "Pause preview" : "Play preview"}
						</Button>

						<div className="space-y-2">
							<label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
								Reference time
							</label>
							<div className="flex gap-1">
								<Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={() => setReferenceTimeFromInput(referenceTimeSec - 5)}>
									-5s
								</Button>
								<Input
									type="number"
									value={formatSeconds(referenceTimeSec)}
									step="0.05"
									min={0}
									max={timelineDurationSec}
									onChange={(event) => setReferenceTimeFromInput(Number(event.target.value))}
									className="h-8 text-xs"
								/>
								<Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={() => setReferenceTimeFromInput(referenceTimeSec + 5)}>
									+5s
								</Button>
							</div>
						</div>

						<div className="space-y-2">
							<label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
								Camera offset
							</label>
							<Input
								type="number"
								value={Math.round(offsetMs)}
								step={25}
								onChange={(event) => setOffsetMs(Math.round(Number(event.target.value) || 0))}
								className="h-8 text-xs"
							/>
							<div className="grid grid-cols-3 gap-1">
								{[-1000, -100, -25, 25, 100, 1000].map((delta) => (
									<Button
										key={delta}
										type="button"
										variant="outline"
										className="h-7 px-1 text-[11px]"
										onClick={() => nudgeOffset(delta)}
									>
										{delta > 0 ? "+" : ""}
										{delta}ms
									</Button>
								))}
							</div>
						</div>

						<div className="space-y-2">
							<label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
								Apply as
							</label>
							<div className="grid gap-1">
								<Button
									type="button"
									variant="outline"
									onClick={() => setMode("camera-only")}
									className={cn(
										"h-8 justify-start text-xs",
										mode === "camera-only" && "border-[#2563EB]/60 bg-[#2563EB]/15",
									)}
								>
									Replace camera only
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={() => setMode("camera-and-audio")}
									className={cn(
										"h-8 justify-start text-xs",
										mode === "camera-and-audio" && "border-[#2563EB]/60 bg-[#2563EB]/15",
									)}
								>
									Replace camera + add audio
								</Button>
							</div>
						</div>

						<div className="space-y-2">
							<label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
								Preview audio
							</label>
							<div className="grid grid-cols-2 gap-1">
								{[
									["replacement", "Replacement"],
									["reference", "Project"],
									["both", "Both"],
									["muted", "Muted"],
								].map(([value, label]) => (
									<Button
										key={value}
										type="button"
										variant="outline"
										className={cn(
											"h-7 px-1 text-[11px]",
											audioMonitor === value && "border-[#2563EB]/60 bg-[#2563EB]/15",
										)}
										onClick={() => setAudioMonitor(value as AudioMonitorMode)}
									>
										{label}
									</Button>
								))}
							</div>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button type="button" onClick={handleApply} disabled={!replacementPath}>
						Apply replacement
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

import type { NativeHelperOutputEvent } from "./nativeHelperOutput";

export interface NativeCaptureHealthIssue {
	event: string;
	severity: "warning" | "error";
	message: string;
	details: Record<string, unknown>;
}

export interface NativeCaptureHealthSupervisorOptions {
	requiresWebcam: boolean;
	requiresMicrophoneAudio?: boolean;
	onIssue: (issue: NativeCaptureHealthIssue) => void;
	isPaused?: () => boolean;
	nowMs?: () => number;
	setIntervalFn?: (callback: () => void, ms: number) => unknown;
	clearIntervalFn?: (timer: unknown) => void;
	checkIntervalMs?: number;
	staleAfterMs?: number;
	lowCadenceAfterMs?: number;
	maxPreviewWriterLagSeconds?: number;
	maxPreviewWriterFrameLag?: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 2000;
const DEFAULT_STALE_AFTER_MS = 15000;
const DEFAULT_LOW_CADENCE_AFTER_MS = 15000;
const DEFAULT_MAX_PREVIEW_WRITER_LAG_SECONDS = 2.5;
const DEFAULT_MAX_PREVIEW_WRITER_FRAME_LAG = 90;

function getFiniteNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class NativeCaptureHealthSupervisor {
	private readonly requiresWebcam: boolean;
	private requiresMicrophoneAudio: boolean;
	private readonly onIssue: (issue: NativeCaptureHealthIssue) => void;
	private readonly isPaused: () => boolean;
	private readonly nowMs: () => number;
	private readonly setIntervalFn: (callback: () => void, ms: number) => unknown;
	private readonly clearIntervalFn: (timer: unknown) => void;
	private readonly checkIntervalMs: number;
	private readonly staleAfterMs: number;
	private readonly lowCadenceAfterMs: number;
	private readonly maxPreviewWriterLagSeconds: number;
	private readonly maxPreviewWriterFrameLag: number;
	private timer: unknown = null;
	private active = false;
	private startedAtMs: number | null = null;
	private videoLastEvidenceAtMs: number | null = null;
	private microphoneAudioLastEvidenceAtMs: number | null = null;
	private webcamLastEvidenceAtMs: number | null = null;
	private webcamPreviewLastEvidenceAtMs: number | null = null;
	private webcamWriterLastPtsSeconds: number | null = null;
	private webcamWriterFrameCount: number | null = null;
	private webcamPreviewAcceptedPtsSeconds: number | null = null;
	private webcamPreviewAcceptedFrame: number | null = null;
	private webcamLowCadenceSinceMs: number | null = null;
	private webcamLowCadenceDetails: Record<string, unknown> | null = null;
	private webcamActive: boolean;
	private videoIssueEmitted = false;
	private microphoneAudioIssueEmitted = false;
	private webcamIssueEmitted = false;
	private wasPaused = false;

	constructor(options: NativeCaptureHealthSupervisorOptions) {
		this.requiresWebcam = options.requiresWebcam;
		this.requiresMicrophoneAudio = Boolean(options.requiresMicrophoneAudio);
		this.onIssue = options.onIssue;
		this.isPaused = options.isPaused ?? (() => false);
		this.nowMs = options.nowMs ?? (() => Date.now());
		this.setIntervalFn = options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
		this.clearIntervalFn =
			options.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
		this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
		this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		this.lowCadenceAfterMs = options.lowCadenceAfterMs ?? DEFAULT_LOW_CADENCE_AFTER_MS;
		this.maxPreviewWriterLagSeconds =
			options.maxPreviewWriterLagSeconds ?? DEFAULT_MAX_PREVIEW_WRITER_LAG_SECONDS;
		this.maxPreviewWriterFrameLag =
			options.maxPreviewWriterFrameLag ?? DEFAULT_MAX_PREVIEW_WRITER_FRAME_LAG;
		this.webcamActive = this.requiresWebcam;
	}

	start() {
		if (this.active) {
			return;
		}
		this.active = true;
		this.startedAtMs = this.nowMs();
		this.timer = this.setIntervalFn(() => this.check(), this.checkIntervalMs);
		this.check();
	}

	stop() {
		this.active = false;
		if (this.timer !== null) {
			this.clearIntervalFn(this.timer);
			this.timer = null;
		}
	}

	setRequiresMicrophoneAudio(required: boolean) {
		this.requiresMicrophoneAudio = required;
		if (!required) {
			this.microphoneAudioLastEvidenceAtMs = null;
			this.microphoneAudioIssueEmitted = false;
		}
	}

	observe(event: NativeHelperOutputEvent) {
		const now = this.nowMs();
		switch (event.event) {
			case "native-video-first-frame-written":
			case "native-video-capture-stats":
				this.videoLastEvidenceAtMs = now;
				break;
			case "native-microphone-audio-first-buffer-written":
			case "native-audio-capture-stats":
				this.microphoneAudioLastEvidenceAtMs = now;
				break;
			case "native-webcam-first-frame-written":
			case "native-webcam-first-visible-frame-written":
			case "native-webcam-capture-stats":
				this.webcamLastEvidenceAtMs = now;
				this.updateWebcamWriterProgress(event.details);
				this.webcamLowCadenceSinceMs = null;
				this.webcamLowCadenceDetails = null;
				break;
			case "native-webcam-proof-preview-accepted":
				this.webcamPreviewLastEvidenceAtMs = now;
				this.updateWebcamPreviewProgress(event.details);
				break;
			case "native-webcam-capture-low-cadence":
				this.webcamLastEvidenceAtMs = now;
				this.updateWebcamWriterProgress(event.details);
				this.webcamLowCadenceSinceMs ??= now;
				this.webcamLowCadenceDetails = event.details;
				break;
			case "native-webcam-visual-stall-suspected":
				// A visually still camera frame is useful evidence, but it is not
				// conclusive by itself. A talking-head recording can stay nearly
				// unchanged for several seconds, so only the native helper's sustained
				// pipeline-stall event should stop the take.
				break;
			case "native-webcam-pipeline-stalled":
			case "native-webcam-capture-disabled":
				this.webcamActive = false;
				this.webcamLowCadenceSinceMs = null;
				this.webcamLowCadenceDetails = null;
				break;
			case "native-video-stream-stopped-with-error":
				this.emitVideoStreamStoppedIssue(now, event.details);
				this.stop();
				break;
			case "native-video-pipeline-stalled":
				this.stop();
				break;
			case "native-audio-pipeline-stalled":
				this.stop();
				break;
		}
	}

	check() {
		if (!this.active) {
			return;
		}

		const now = this.nowMs();
		if (this.isPaused()) {
			this.wasPaused = true;
			return;
		}

		if (this.wasPaused) {
			this.wasPaused = false;
			this.refreshEvidenceAfterPause(now);
		}

		this.checkVideo(now);
		this.checkMicrophoneAudio(now);
		this.checkWebcam(now);
	}

	private refreshEvidenceAfterPause(now: number) {
		if (this.videoLastEvidenceAtMs !== null) {
			this.videoLastEvidenceAtMs = now;
		}
		if (this.microphoneAudioLastEvidenceAtMs !== null) {
			this.microphoneAudioLastEvidenceAtMs = now;
		} else if (this.requiresMicrophoneAudio) {
			this.startedAtMs = now;
		}
		if (this.webcamLastEvidenceAtMs !== null) {
			this.webcamLastEvidenceAtMs = now;
		}
		if (this.webcamPreviewLastEvidenceAtMs !== null) {
			this.webcamPreviewLastEvidenceAtMs = now;
		}
		this.webcamLowCadenceSinceMs = null;
		this.webcamLowCadenceDetails = null;
	}

	private checkVideo(now: number) {
		if (this.videoIssueEmitted) {
			return;
		}
		if (this.videoLastEvidenceAtMs === null) {
			this.emitVideoIssue(now, null);
			return;
		}

		const staleForMs = now - this.videoLastEvidenceAtMs;
		if (staleForMs >= this.staleAfterMs) {
			this.emitVideoIssue(now, staleForMs);
		}
	}

	private checkMicrophoneAudio(now: number) {
		if (!this.requiresMicrophoneAudio || this.microphoneAudioIssueEmitted) {
			return;
		}
		const lastEvidenceAtMs = this.microphoneAudioLastEvidenceAtMs ?? this.startedAtMs;
		if (lastEvidenceAtMs === null) {
			return;
		}
		const staleForMs = now - lastEvidenceAtMs;
		if (staleForMs >= this.staleAfterMs) {
			this.emitMicrophoneAudioIssue(now, staleForMs);
		}
	}

	private checkWebcam(now: number) {
		if (!this.webcamActive || this.webcamIssueEmitted) {
			return;
		}
		if (this.webcamLastEvidenceAtMs === null) {
			this.emitWebcamIssue(now, null);
			return;
		}

		const staleForMs = now - this.webcamLastEvidenceAtMs;
		if (staleForMs >= this.staleAfterMs) {
			this.emitWebcamIssue(now, staleForMs);
			return;
		}

		if (this.webcamLowCadenceSinceMs !== null) {
			const lowCadenceForMs = now - this.webcamLowCadenceSinceMs;
			if (lowCadenceForMs >= this.lowCadenceAfterMs) {
				this.emitWebcamLowCadenceIssue(now, lowCadenceForMs);
				return;
			}
		}

		if (this.webcamPreviewLastEvidenceAtMs === null) {
			this.emitWebcamProofPreviewIssue(now, null);
			return;
		}

		const previewStaleForMs = now - this.webcamPreviewLastEvidenceAtMs;
		if (previewStaleForMs >= this.staleAfterMs) {
			this.emitWebcamProofPreviewIssue(now, previewStaleForMs);
			return;
		}

		if (
			this.webcamWriterLastPtsSeconds !== null &&
			this.webcamPreviewAcceptedPtsSeconds !== null
		) {
			const previewWriterLagSeconds =
				this.webcamWriterLastPtsSeconds - this.webcamPreviewAcceptedPtsSeconds;
			if (previewWriterLagSeconds > this.maxPreviewWriterLagSeconds) {
				this.emitWebcamProofPreviewLagIssue(now, previewWriterLagSeconds);
				return;
			}
		}

		if (this.webcamWriterFrameCount !== null && this.webcamPreviewAcceptedFrame !== null) {
			const previewWriterFrameLag =
				this.webcamWriterFrameCount - this.webcamPreviewAcceptedFrame;
			if (previewWriterFrameLag > this.maxPreviewWriterFrameLag) {
				this.emitWebcamProofPreviewLagIssue(now, null, previewWriterFrameLag);
			}
		}
	}

	private updateWebcamWriterProgress(details: Record<string, unknown>) {
		const lastPts = getFiniteNumber(details.lastPts);
		if (lastPts !== null) {
			this.webcamWriterLastPtsSeconds = lastPts;
		}
		const frames = getFiniteNumber(details.frames);
		if (frames !== null) {
			this.webcamWriterFrameCount = frames;
		}
	}

	private updateWebcamPreviewProgress(details: Record<string, unknown>) {
		const acceptedPts = getFiniteNumber(details.acceptedPts);
		if (acceptedPts !== null) {
			this.webcamPreviewAcceptedPtsSeconds = acceptedPts;
		}
		const acceptedFrame = getFiniteNumber(details.acceptedFrame);
		if (acceptedFrame !== null) {
			this.webcamPreviewAcceptedFrame = acceptedFrame;
		}
	}

	private emitVideoIssue(now: number, staleForMs: number | null) {
		if (this.videoIssueEmitted) {
			return;
		}
		this.videoIssueEmitted = true;
		this.onIssue({
			event: "native-video-capture-stats-stale",
			severity: "error",
			message:
				"Native screen recording stopped reporting written frames. Recordly stopped the recording instead of trusting a stale capture pipeline.",
			details: {
				nowMs: now,
				staleForMs,
				staleAfterMs: this.staleAfterMs,
			},
		});
	}

	private emitVideoStreamStoppedIssue(now: number, details: Record<string, unknown>) {
		if (this.videoIssueEmitted) {
			return;
		}
		this.videoIssueEmitted = true;
		this.onIssue({
			event: "native-video-stream-stopped-with-error",
			severity: "error",
			message:
				"Screen capture stream stopped unexpectedly. Recordly stopped the recording instead of extending stale frames.",
			details: {
				nowMs: now,
				...details,
			},
		});
	}

	private emitMicrophoneAudioIssue(now: number, staleForMs: number) {
		this.microphoneAudioIssueEmitted = true;
		this.onIssue({
			event: "native-audio-capture-stats-stale",
			severity: "error",
			message:
				"Native microphone audio stopped reporting samples while the recording was still active. Recordly stopped the take instead of saving an out-of-sync file.",
			details: {
				nowMs: now,
				staleForMs,
				staleAfterMs: this.staleAfterMs,
			},
		});
	}

	private emitWebcamIssue(now: number, staleForMs: number | null) {
		this.webcamIssueEmitted = true;
		this.onIssue({
			event: "native-webcam-capture-stats-stale",
			severity: "error",
			message:
				"Native webcam recording stopped reporting written frames. Recordly stopped the recording instead of saving frozen or missing facecam footage.",
			details: {
				nowMs: now,
				staleForMs,
				staleAfterMs: this.staleAfterMs,
			},
		});
	}

	private emitWebcamLowCadenceIssue(now: number, lowCadenceForMs: number) {
		this.webcamIssueEmitted = true;
		this.onIssue({
			event: "native-webcam-capture-low-cadence-sustained",
			severity: "error",
			message:
				"Native webcam recording cadence stayed too low. Recordly stopped the recording instead of saving a choppy or frozen facecam track.",
			details: {
				nowMs: now,
				lowCadenceForMs,
				lowCadenceAfterMs: this.lowCadenceAfterMs,
				...(this.webcamLowCadenceDetails ?? {}),
			},
		});
	}

	private emitWebcamProofPreviewIssue(now: number, previewStaleForMs: number | null) {
		this.webcamIssueEmitted = true;
		this.onIssue({
			event: "native-webcam-proof-preview-stale",
			severity: "error",
			message:
				"Native webcam proof preview stopped reporting accepted writer frames. Recordly stopped the recording instead of trusting hidden camera state.",
			details: {
				nowMs: now,
				previewStaleForMs,
				staleAfterMs: this.staleAfterMs,
			},
		});
	}

	private emitWebcamProofPreviewLagIssue(
		now: number,
		previewWriterLagSeconds: number | null,
		previewWriterFrameLag: number | null = null,
	) {
		this.webcamIssueEmitted = true;
		this.onIssue({
			event: "native-webcam-proof-preview-lagging",
			severity: "error",
			message:
				"Native webcam proof preview fell behind the writer. Recordly stopped the recording instead of showing stale camera frames while saving newer frames.",
			details: {
				nowMs: now,
				previewWriterLagSeconds,
				previewWriterFrameLag,
				maxPreviewWriterLagSeconds: this.maxPreviewWriterLagSeconds,
				maxPreviewWriterFrameLag: this.maxPreviewWriterFrameLag,
				writerLastPts: this.webcamWriterLastPtsSeconds,
				writerFrames: this.webcamWriterFrameCount,
				previewAcceptedPts: this.webcamPreviewAcceptedPtsSeconds,
				previewAcceptedFrame: this.webcamPreviewAcceptedFrame,
			},
		});
	}
}

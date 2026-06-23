import { describe, expect, it, vi } from "vitest";
import {
	type NativeCaptureHealthIssue,
	NativeCaptureHealthSupervisor,
} from "./nativeCaptureHealth";
import type { NativeHelperOutputEvent } from "./nativeHelperOutput";

function event(name: string, details: Record<string, unknown> = {}): NativeHelperOutputEvent {
	return {
		event: name,
		severity: "info",
		details,
	};
}

describe("NativeCaptureHealthSupervisor", () => {
	it("does not report stale capture while native writer stats are fresh", () => {
		let now = 1000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.start();
		now += 7000;
		supervisor.observe(event("native-video-capture-stats"));
		now += 7000;
		supervisor.check();

		expect(issues).toEqual([]);
	});

	it("reports stale screen capture when native writer stats stop", () => {
		let now = 1000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.start();
		now += 15000;
		supervisor.check();
		now += 15000;
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-video-capture-stats-stale",
			severity: "error",
			details: {
				staleForMs: 15000,
				staleAfterMs: 15000,
			},
		});
	});

	it("does not report stale screen capture while native recording is paused", () => {
		let now = 1000;
		let paused = false;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			isPaused: () => paused,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.start();
		paused = true;
		now += 120000;
		supervisor.check();
		paused = false;
		supervisor.check();
		now += 14999;
		supervisor.check();

		expect(issues).toEqual([]);
		now += 1;
		supervisor.check();
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-video-capture-stats-stale",
			details: {
				staleForMs: 15000,
			},
		});
	});

	it("reports native screen stream errors immediately", () => {
		let now = 1000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.start();
		now += 1000;
		supervisor.observe(
			event("native-video-stream-stopped-with-error", {
				message: "stream disconnected",
			}),
		);
		now += 30000;
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-video-stream-stopped-with-error",
			severity: "error",
			details: {
				message: "stream disconnected",
			},
		});
	});

	it("reports stale microphone audio when native audio stats stop", () => {
		let now = 1000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			requiresMicrophoneAudio: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-microphone-audio-first-buffer-written"));
		supervisor.start();
		now += 7000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-audio-capture-stats"));
		now += 15000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-audio-capture-stats-stale",
			severity: "error",
			details: {
				staleForMs: 15000,
				staleAfterMs: 15000,
			},
		});
	});

	it("gives native microphone audio startup a grace window before failing", () => {
		let now = 1000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			requiresMicrophoneAudio: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.start();
		now += 14999;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.check();
		expect(issues).toEqual([]);

		now += 1;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.check();
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-audio-capture-stats-stale",
			details: {
				staleForMs: 15000,
			},
		});
	});

	it("does not report stale native microphone audio after mic monitoring is disabled", () => {
		let now = 1000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			requiresMicrophoneAudio: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.start();
		supervisor.setRequiresMicrophoneAudio(false);
		now += 30000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.check();

		expect(issues).toEqual([]);
	});

	it("does not treat final keep-alive frames as live screen capture evidence", () => {
		let now = 1000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: false,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.start();
		now += 14000;
		supervisor.observe(event("native-final-video-keepalive-appended"));
		now += 1000;
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-video-capture-stats-stale",
			severity: "error",
			details: {
				staleForMs: 15000,
			},
		});
	});

	it("reports stale webcam capture when webcam writer stats stop", () => {
		let now = 2000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 7000;
		supervisor.observe(event("native-video-capture-stats"));
		now += 8000;
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-capture-stats-stale",
			severity: "error",
			details: {
				staleForMs: 15000,
			},
		});
	});

	it("does not report stale webcam or proof-preview capture while native recording is paused", () => {
		let now = 5000;
		let paused = false;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			isPaused: () => paused,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			lowCadenceAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.observe(event("native-webcam-capture-low-cadence", { recentFps: 4 }));
		supervisor.start();
		paused = true;
		now += 180000;
		supervisor.check();
		paused = false;
		supervisor.check();
		now += 14999;
		supervisor.check();

		expect(issues).toEqual([]);
		now += 1;
		supervisor.check();
		expect(issues.map((issue) => issue.event)).toEqual([
			"native-video-capture-stats-stale",
			"native-webcam-capture-stats-stale",
		]);
		expect(issues[0].details).toMatchObject({ staleForMs: 15000 });
		expect(issues[1].details).toMatchObject({ staleForMs: 15000 });
	});

	it("does not treat native proof-preview frames as webcam writer stats", () => {
		let now = 4000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 14000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		now += 1000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-capture-stats-stale",
			severity: "error",
			details: {
				staleForMs: 15000,
			},
		});
	});

	it("does not fail a brief low-cadence webcam dip", () => {
		let now = 4000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			lowCadenceAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-low-cadence", { recentFps: 4.5 }));
		now += 14000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.check();

		expect(issues).toEqual([]);
	});

	it("clears low-cadence tracking when healthy webcam writer stats recover", () => {
		let now = 4000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			lowCadenceAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-low-cadence", { recentFps: 4.5 }));
		now += 8000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 29.8 }));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		now += 15000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 30 }));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.check();

		expect(issues).toEqual([]);
	});

	it("fails closed when low webcam writer cadence is sustained", () => {
		let now = 4000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			lowCadenceAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-low-cadence", { recentFps: 4.5 }));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-low-cadence", { recentFps: 3.5 }));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.check();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-low-cadence", { recentFps: 2.5 }));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.check();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-low-cadence", { recentFps: 1.5 }));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-capture-low-cadence-sustained",
			severity: "error",
			details: {
				lowCadenceForMs: 15000,
				lowCadenceAfterMs: 15000,
				recentFps: 1.5,
			},
		});
	});

	it("does not fail closed on visual-stall suspicion without a sustained native stall", () => {
		let now = 4000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-visible-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 9000;
		supervisor.observe(
			event("native-webcam-visual-stall-suspected", {
				stalledFor: 8.02,
				meanDiff: 0.08,
			}),
		);
		supervisor.observe(
			event("native-webcam-visual-stall-suspected", {
				stalledFor: 10.01,
				meanDiff: 0.05,
			}),
		);

		expect(issues).toHaveLength(0);
	});

	it("stops supervising webcam once native webcam capture is disabled", () => {
		let now = 3000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		supervisor.observe(event("native-webcam-capture-disabled"));
		now += 15000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.check();

		expect(issues).toEqual([]);
	});

	it("fails closed when proof-preview stops while native webcam writer stats stay fresh", () => {
		let now = 5000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-visible-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 30 }));
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 30 }));
		supervisor.check();
		expect(issues).toEqual([]);

		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 30 }));
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-proof-preview-stale",
			severity: "error",
			details: {
				previewStaleForMs: 15000,
				staleAfterMs: 15000,
			},
		});
	});

	it("does not treat raw helper preview frames as accepted proof-preview evidence", () => {
		let now = 5000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-visible-frame-written"));
		supervisor.observe(event("native-webcam-proof-preview-accepted"));
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 30 }));
		supervisor.observe(event("native-webcam-preview-frame-written"));
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 30 }));
		supervisor.observe(event("native-webcam-preview-frame-written"));
		supervisor.check();
		expect(issues).toEqual([]);

		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(event("native-webcam-capture-stats", { recentFps: 30 }));
		supervisor.observe(event("native-webcam-preview-frame-written"));
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-proof-preview-stale",
			severity: "error",
			details: {
				previewStaleForMs: 15000,
			},
		});
	});

	it("does not fail when accepted proof-preview stays close to webcam writer progress", () => {
		let now = 5000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			maxPreviewWriterLagSeconds: 2.5,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-visible-frame-written"));
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 30,
				acceptedPts: 1,
			}),
		);
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(
			event("native-webcam-capture-stats", {
				frames: 180,
				recentFps: 30,
				lastPts: 6,
			}),
		);
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 120,
				acceptedPts: 4,
			}),
		);
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 176,
				acceptedPts: 5.86,
			}),
		);
		supervisor.check();

		expect(issues).toEqual([]);
	});

	it("fails closed when accepted proof-preview jumps too far between accepted frames", () => {
		let now = 5000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			maxAcceptedProofGapSeconds: 3.5,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-visible-frame-written"));
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 30,
				acceptedPts: 1,
			}),
		);
		supervisor.start();
		now += 1000;
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 155,
				acceptedPts: 5.1,
			}),
		);

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-proof-preview-gap",
			severity: "error",
			details: {
				acceptedProofGapSeconds: 4.1,
				maxAcceptedProofGapSeconds: 3.5,
				previousAcceptedPts: 1,
				currentAcceptedPts: 5.1,
				previousAcceptedFrame: 30,
				currentAcceptedFrame: 155,
			},
		});
	});

	it("fails closed when accepted proof-preview falls behind webcam writer progress", () => {
		let now = 5000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			maxPreviewWriterLagSeconds: 2.5,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-visible-frame-written"));
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 30,
				acceptedPts: 1,
			}),
		);
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(
			event("native-webcam-capture-stats", {
				frames: 210,
				recentFps: 30,
				lastPts: 7,
			}),
		);
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-proof-preview-lagging",
			severity: "error",
			details: {
				previewWriterLagSeconds: 6,
				maxPreviewWriterLagSeconds: 2.5,
				writerLastPts: 7,
				writerFrames: 210,
				previewAcceptedPts: 1,
				previewAcceptedFrame: 30,
			},
		});
	});

	it("fails closed when proof-preview frame count falls behind even if timestamps are close", () => {
		let now = 5000;
		const issues: NativeCaptureHealthIssue[] = [];
		const supervisor = new NativeCaptureHealthSupervisor({
			requiresWebcam: true,
			nowMs: () => now,
			setIntervalFn: vi.fn(),
			clearIntervalFn: vi.fn(),
			staleAfterMs: 15000,
			maxPreviewWriterLagSeconds: 2.5,
			maxPreviewWriterFrameLag: 90,
			onIssue: (issue) => issues.push(issue),
		});

		supervisor.observe(event("native-video-first-frame-written"));
		supervisor.observe(event("native-webcam-first-visible-frame-written"));
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 30,
				acceptedPts: 1,
			}),
		);
		supervisor.start();
		now += 5000;
		supervisor.observe(event("native-video-capture-stats"));
		supervisor.observe(
			event("native-webcam-capture-stats", {
				frames: 500,
				recentFps: 30,
				lastPts: 6,
			}),
		);
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 180,
				acceptedPts: 3,
			}),
		);
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 300,
				acceptedPts: 5,
			}),
		);
		supervisor.observe(
			event("native-webcam-proof-preview-accepted", {
				acceptedFrame: 400,
				acceptedPts: 5.95,
			}),
		);
		supervisor.check();

		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			event: "native-webcam-proof-preview-lagging",
			severity: "error",
			details: {
				previewWriterLagSeconds: null,
				previewWriterFrameLag: 100,
				maxPreviewWriterFrameLag: 90,
				writerLastPts: 6,
				writerFrames: 500,
				previewAcceptedPts: 5.95,
				previewAcceptedFrame: 400,
			},
		});
	});
});

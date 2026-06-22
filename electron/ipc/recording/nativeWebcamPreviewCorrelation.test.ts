import { describe, expect, it } from "vitest";
import {
	createNativeWebcamPreviewCorrelationTracker,
	resolveNativeWebcamPreviewCorrelation,
} from "./nativeWebcamPreviewCorrelation";

describe("resolveNativeWebcamPreviewCorrelation", () => {
	it("accepts proof-preview frames only when they reference an accepted writer frame", () => {
		expect(
			resolveNativeWebcamPreviewCorrelation({
				sequence: 4,
				acceptedFrame: 42,
				acceptedPts: 1.366,
			}),
		).toEqual({
			sequence: 4,
			acceptedFrame: 42,
			acceptedPts: 1.366,
		});
	});

	it.each([
		{ sequence: 4, acceptedPts: 1.366 },
		{ sequence: 4, acceptedFrame: 42 },
		{ acceptedFrame: 42, acceptedPts: 1.366 },
		{ sequence: 0, acceptedFrame: 42, acceptedPts: 1.366 },
		{ sequence: 4, acceptedFrame: 0, acceptedPts: 1.366 },
		{ sequence: 4, acceptedFrame: 42, acceptedPts: -1 },
	])("rejects uncorrelated proof-preview details: %o", (details) => {
		expect(resolveNativeWebcamPreviewCorrelation(details)).toBeNull();
	});
});

describe("createNativeWebcamPreviewCorrelationTracker", () => {
	it("accepts only monotonic proof-preview frames from accepted writer frames", () => {
		const accept = createNativeWebcamPreviewCorrelationTracker();

		expect(
			accept({
				sequence: 1,
				acceptedFrame: 30,
				acceptedPts: 1,
			}),
		).toEqual({
			accepted: true,
			correlation: {
				sequence: 1,
				acceptedFrame: 30,
				acceptedPts: 1,
			},
			consecutiveRejectedCount: 0,
			failClosed: false,
		});

		expect(
			accept({
				sequence: 2,
				acceptedFrame: 36,
				acceptedPts: 1.2,
			}),
		).toEqual({
			accepted: true,
			correlation: {
				sequence: 2,
				acceptedFrame: 36,
				acceptedPts: 1.2,
			},
			consecutiveRejectedCount: 0,
			failClosed: false,
		});
	});

	it("rejects repeated or out-of-order preview sequences", () => {
		const accept = createNativeWebcamPreviewCorrelationTracker();
		accept({ sequence: 4, acceptedFrame: 42, acceptedPts: 1.4 });

		expect(accept({ sequence: 4, acceptedFrame: 43, acceptedPts: 1.433 })).toEqual({
			accepted: false,
			reason: "non-monotonic-preview-sequence",
			correlation: {
				sequence: 4,
				acceptedFrame: 43,
				acceptedPts: 1.433,
			},
			previous: {
				sequence: 4,
				acceptedFrame: 42,
				acceptedPts: 1.4,
			},
			consecutiveRejectedCount: 1,
			failClosed: false,
		});
	});

	it("rejects repeated accepted writer frames even when the preview sequence advances", () => {
		const accept = createNativeWebcamPreviewCorrelationTracker();
		accept({ sequence: 4, acceptedFrame: 42, acceptedPts: 1.4 });

		expect(accept({ sequence: 5, acceptedFrame: 42, acceptedPts: 1.433 })).toEqual({
			accepted: false,
			reason: "non-monotonic-accepted-frame",
			correlation: {
				sequence: 5,
				acceptedFrame: 42,
				acceptedPts: 1.433,
			},
			previous: {
				sequence: 4,
				acceptedFrame: 42,
				acceptedPts: 1.4,
			},
			consecutiveRejectedCount: 1,
			failClosed: false,
		});
	});

	it("rejects accepted writer timestamps that move backwards", () => {
		const accept = createNativeWebcamPreviewCorrelationTracker();
		accept({ sequence: 4, acceptedFrame: 42, acceptedPts: 1.4 });

		expect(accept({ sequence: 5, acceptedFrame: 43, acceptedPts: 1.3 })).toEqual({
			accepted: false,
			reason: "accepted-pts-went-backwards",
			correlation: {
				sequence: 5,
				acceptedFrame: 43,
				acceptedPts: 1.3,
			},
			previous: {
				sequence: 4,
				acceptedFrame: 42,
				acceptedPts: 1.4,
			},
			consecutiveRejectedCount: 1,
			failClosed: false,
		});
	});

	it("keeps the previous accepted frame after rejecting stale proof evidence", () => {
		const accept = createNativeWebcamPreviewCorrelationTracker();
		accept({ sequence: 4, acceptedFrame: 42, acceptedPts: 1.4 });
		accept({ sequence: 5, acceptedFrame: 42, acceptedPts: 1.433 });

		expect(accept({ sequence: 6, acceptedFrame: 43, acceptedPts: 1.433 })).toEqual({
			accepted: true,
			correlation: {
				sequence: 6,
				acceptedFrame: 43,
				acceptedPts: 1.433,
			},
			consecutiveRejectedCount: 0,
			failClosed: false,
		});
	});

	it("fails closed after repeated rejected proof-preview frames", () => {
		const accept = createNativeWebcamPreviewCorrelationTracker({
			failClosedAfterRejectedFrames: 3,
		});
		accept({ sequence: 4, acceptedFrame: 42, acceptedPts: 1.4 });

		expect(
			accept({ sequence: 5, acceptedFrame: 42, acceptedPts: 1.433 }),
		).toMatchObject({
			accepted: false,
			reason: "non-monotonic-accepted-frame",
			consecutiveRejectedCount: 1,
			failClosed: false,
		});
		expect(
			accept({ sequence: 6, acceptedFrame: 42, acceptedPts: 1.466 }),
		).toMatchObject({
			accepted: false,
			reason: "non-monotonic-accepted-frame",
			consecutiveRejectedCount: 2,
			failClosed: false,
		});
		expect(
			accept({ sequence: 7, acceptedFrame: 42, acceptedPts: 1.5 }),
		).toMatchObject({
			accepted: false,
			reason: "non-monotonic-accepted-frame",
			consecutiveRejectedCount: 3,
			failClosed: true,
		});
	});

	it("resets the repeated-rejection counter after valid proof evidence resumes", () => {
		const accept = createNativeWebcamPreviewCorrelationTracker({
			failClosedAfterRejectedFrames: 3,
		});
		accept({ sequence: 4, acceptedFrame: 42, acceptedPts: 1.4 });
		accept({ sequence: 5, acceptedFrame: 42, acceptedPts: 1.433 });
		accept({ sequence: 6, acceptedFrame: 43, acceptedPts: 1.433 });

		expect(
			accept({ sequence: 7, acceptedFrame: 43, acceptedPts: 1.466 }),
		).toMatchObject({
			accepted: false,
			reason: "non-monotonic-accepted-frame",
			consecutiveRejectedCount: 1,
			failClosed: false,
		});
	});
});

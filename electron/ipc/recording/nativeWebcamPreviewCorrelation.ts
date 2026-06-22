export type NativeWebcamPreviewCorrelation =
	| {
			acceptedFrame: number;
			acceptedPts: number;
			sequence: number;
	  }
	| null;

function getFiniteNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveNativeWebcamPreviewCorrelation(
	details: Record<string, unknown>,
): NativeWebcamPreviewCorrelation {
	const sequence = getFiniteNumber(details.sequence);
	const acceptedFrame = getFiniteNumber(details.acceptedFrame);
	const acceptedPts = getFiniteNumber(details.acceptedPts);

	if (
		sequence === null ||
		sequence <= 0 ||
		acceptedFrame === null ||
		acceptedFrame <= 0 ||
		acceptedPts === null ||
		acceptedPts < 0
	) {
		return null;
	}

	return {
		sequence,
		acceptedFrame,
		acceptedPts,
	};
}

export type NativeWebcamPreviewCorrelationDecision =
	| {
			accepted: true;
			correlation: NonNullable<NativeWebcamPreviewCorrelation>;
			consecutiveRejectedCount: 0;
			failClosed: false;
	  }
	| {
			accepted: false;
			reason:
				| "missing-writer-correlation"
				| "non-monotonic-preview-sequence"
				| "non-monotonic-accepted-frame"
				| "accepted-pts-went-backwards";
			correlation: NativeWebcamPreviewCorrelation;
			previous: NonNullable<NativeWebcamPreviewCorrelation> | null;
			consecutiveRejectedCount: number;
			failClosed: boolean;
	  };

const DEFAULT_FAIL_CLOSED_AFTER_REJECTED_PREVIEW_FRAMES = 3;

export function createNativeWebcamPreviewCorrelationTracker({
	failClosedAfterRejectedFrames = DEFAULT_FAIL_CLOSED_AFTER_REJECTED_PREVIEW_FRAMES,
}: {
	failClosedAfterRejectedFrames?: number;
} = {}) {
	let previous: NonNullable<NativeWebcamPreviewCorrelation> | null = null;
	let consecutiveRejectedCount = 0;

	const reject = (
		reason: Exclude<
			NativeWebcamPreviewCorrelationDecision,
			{ accepted: true }
		>["reason"],
		correlation: NativeWebcamPreviewCorrelation,
	): NativeWebcamPreviewCorrelationDecision => {
		consecutiveRejectedCount += 1;
		return {
			accepted: false,
			reason,
			correlation,
			previous,
			consecutiveRejectedCount,
			failClosed: consecutiveRejectedCount >= failClosedAfterRejectedFrames,
		};
	};

	return (details: Record<string, unknown>): NativeWebcamPreviewCorrelationDecision => {
		const correlation = resolveNativeWebcamPreviewCorrelation(details);
		if (!correlation) {
			return reject("missing-writer-correlation", correlation);
		}

		if (previous) {
			if (correlation.sequence <= previous.sequence) {
				return reject("non-monotonic-preview-sequence", correlation);
			}

			if (correlation.acceptedFrame <= previous.acceptedFrame) {
				return reject("non-monotonic-accepted-frame", correlation);
			}

			if (correlation.acceptedPts < previous.acceptedPts) {
				return reject("accepted-pts-went-backwards", correlation);
			}
		}

		consecutiveRejectedCount = 0;
		previous = correlation;
		return {
			accepted: true,
			correlation,
			consecutiveRejectedCount: 0,
			failClosed: false,
		};
	};
}

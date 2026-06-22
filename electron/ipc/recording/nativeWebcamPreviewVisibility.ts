export type NativeWebcamPreviewStartupTimeoutFailure = {
	error: string;
	details: Record<string, unknown>;
};

export function shouldExposeNativeWebcamPreviewProofFrame({
	hasVisibleWebcamFrame,
}: {
	hasVisibleWebcamFrame: boolean;
}) {
	return hasVisibleWebcamFrame;
}

export function resolveNativeWebcamPreviewStartupTimeoutFailure({
	acceptedProofCount,
	hasVisibleWebcamFrame,
	lastAcceptedProof,
	timeoutMs,
}: {
	acceptedProofCount: number;
	hasVisibleWebcamFrame: boolean;
	lastAcceptedProof: unknown;
	timeoutMs: number;
}): NativeWebcamPreviewStartupTimeoutFailure {
	const details = {
		timeoutMs,
		acceptedProofCount,
		hasVisibleWebcamFrame,
		lastAcceptedProof,
	};

	if (acceptedProofCount > 0 && !hasVisibleWebcamFrame) {
		return {
			error: "native-preview-blank-webcam",
			details,
		};
	}

	return {
		error: "native-preview-first-frame-timeout",
		details,
	};
}

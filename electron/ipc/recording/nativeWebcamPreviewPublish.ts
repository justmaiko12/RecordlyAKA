export type NativeWebcamProofPreviewPublishDecision =
	| {
			accepted: true;
	  }
	| {
			accepted: false;
			reason: "mjpeg-preview-publish-failed";
			details: {
				streamId: string | null;
				framePath: string;
				sequence: number;
			};
	  };

export function publishNativeWebcamProofPreviewFrame({
	streamId,
	framePath,
	sequence,
	publishFrame,
}: {
	streamId: string | null;
	framePath: string;
	sequence: number;
	publishFrame: (streamId: string, framePath: string, sequence: number) => boolean;
}): NativeWebcamProofPreviewPublishDecision {
	if (!streamId || !publishFrame(streamId, framePath, sequence)) {
		return {
			accepted: false,
			reason: "mjpeg-preview-publish-failed",
			details: {
				streamId,
				framePath,
				sequence,
			},
		};
	}

	return { accepted: true };
}

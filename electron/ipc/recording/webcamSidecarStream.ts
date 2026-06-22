import fs from "node:fs/promises";
import path from "node:path";
import { appendRecordingEventLogEntry } from "./recordingEventLog";

type WebcamSidecarStreamState = {
	streamId: string;
	sessionId: string;
	filePath: string;
	mimeType: string | null;
	bytesWritten: number;
	chunksWritten: number;
	startedAt: string;
};

export type WebcamSidecarStreamStartInput = {
	recordingsDir: string;
	sessionId: string;
	fileName: string;
	mimeType?: string | null;
};

export type WebcamSidecarChunkInput = {
	streamId: string;
	chunk: ArrayBuffer | Buffer;
	index?: number | null;
	elapsedMs?: number | null;
};

function normalizeFileName(fileName: string) {
	const normalized = path.basename(fileName.trim());
	if (!normalized || normalized !== fileName.trim()) {
		throw new Error("Invalid webcam sidecar file name");
	}
	return normalized;
}

function byteLength(value: ArrayBuffer | Buffer) {
	return Buffer.isBuffer(value) ? value.byteLength : value.byteLength;
}

function toBuffer(value: ArrayBuffer | Buffer) {
	return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class WebcamSidecarStreamRegistry {
	private readonly streams = new Map<string, WebcamSidecarStreamState>();

	async start({
		recordingsDir,
		sessionId,
		fileName,
		mimeType = null,
	}: WebcamSidecarStreamStartInput) {
		const normalizedFileName = normalizeFileName(fileName);
		const streamId = `${sessionId}:webcam`;
		const filePath = path.join(recordingsDir, normalizedFileName);
		const state: WebcamSidecarStreamState = {
			streamId,
			sessionId,
			filePath,
			mimeType,
			bytesWritten: 0,
			chunksWritten: 0,
			startedAt: new Date().toISOString(),
		};

		await fs.mkdir(recordingsDir, { recursive: true });
		await fs.writeFile(filePath, Buffer.alloc(0));
		this.streams.set(streamId, state);
		await appendRecordingEventLogEntry({
			recordingsDir,
			sessionId,
			event: "webcam-sidecar-stream-started",
			details: { filePath, mimeType },
		});

		return {
			streamId,
			path: filePath,
			bytesWritten: state.bytesWritten,
			chunksWritten: state.chunksWritten,
		};
	}

	async append({ streamId, chunk, index = null, elapsedMs = null }: WebcamSidecarChunkInput) {
		const state = this.streams.get(streamId);
		if (!state) {
			throw new Error(`Unknown webcam sidecar stream: ${streamId}`);
		}

		const bytes = byteLength(chunk);
		if (bytes <= 0) {
			return {
				path: state.filePath,
				bytesWritten: state.bytesWritten,
				chunksWritten: state.chunksWritten,
			};
		}

		await fs.appendFile(state.filePath, toBuffer(chunk));
		state.bytesWritten += bytes;
		state.chunksWritten += 1;
		if (state.chunksWritten === 1 || state.chunksWritten % 20 === 0) {
			await appendRecordingEventLogEntry({
				recordingsDir: path.dirname(state.filePath),
				sessionId: state.sessionId,
				event: "webcam-sidecar-chunk-written",
				details: {
					filePath: state.filePath,
					index,
					elapsedMs,
					bytes,
					bytesWritten: state.bytesWritten,
					chunksWritten: state.chunksWritten,
				},
			});
		}

		return {
			path: state.filePath,
			bytesWritten: state.bytesWritten,
			chunksWritten: state.chunksWritten,
		};
	}

	async finish(streamId: string) {
		const state = this.streams.get(streamId);
		if (!state) {
			throw new Error(`Unknown webcam sidecar stream: ${streamId}`);
		}

		this.streams.delete(streamId);
		await appendRecordingEventLogEntry({
			recordingsDir: path.dirname(state.filePath),
			sessionId: state.sessionId,
			event: "webcam-sidecar-stream-finished",
			details: {
				filePath: state.filePath,
				bytesWritten: state.bytesWritten,
				chunksWritten: state.chunksWritten,
				startedAt: state.startedAt,
			},
		});

		return {
			path: state.filePath,
			sessionId: state.sessionId,
			mimeType: state.mimeType,
			bytesWritten: state.bytesWritten,
			chunksWritten: state.chunksWritten,
		};
	}

	async abort(streamId: string, reason?: string) {
		const state = this.streams.get(streamId);
		if (!state) {
			return null;
		}

		this.streams.delete(streamId);
		await appendRecordingEventLogEntry({
			recordingsDir: path.dirname(state.filePath),
			sessionId: state.sessionId,
			event: "webcam-sidecar-stream-aborted",
			details: {
				filePath: state.filePath,
				bytesWritten: state.bytesWritten,
				chunksWritten: state.chunksWritten,
				reason,
			},
		});

		return {
			path: state.filePath,
			bytesWritten: state.bytesWritten,
			chunksWritten: state.chunksWritten,
		};
	}
}

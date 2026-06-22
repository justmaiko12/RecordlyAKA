import { createReadStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { approvedLocalReadPaths } from "./ipc/state";
import { getMediaContentType } from "./mediaTypes";

let mediaServerBaseUrl: string | null = null;
let mediaServerStartPromise: Promise<string> | null = null;
const mjpegBoundary = "recordly-native-webcam-preview";
const mjpegBackpressureTimeoutMs = 500;
const mjpegPreviewMinWriteIntervalMs = 33;
const mjpegPreviewFallbackPollMs = 1000;
const mjpegPreviewSnapshotHistoryLimit = 120;

type MjpegPreviewFrame = {
	data: Buffer;
	path: string;
	sequence: number;
};

type MjpegPreviewSubscriber = {
	response: ServerResponse;
	requestWriteLatestFrame: () => void;
	close: () => void;
};

type MjpegPreviewStreamState = {
	allowedPaths: Set<string>;
	framesBySequence: Map<number, MjpegPreviewFrame>;
	latestFrame: MjpegPreviewFrame | null;
	subscribers: Set<MjpegPreviewSubscriber>;
};

const mjpegPreviewStreams = new Map<string, MjpegPreviewStreamState>();

function waitForMjpegResponseDrain(
	response: ServerResponse,
	timeoutMs = mjpegBackpressureTimeoutMs,
): Promise<"drain" | "closed" | "timeout"> {
	if (response.destroyed) {
		return Promise.resolve("closed");
	}

	return new Promise((resolve) => {
		let timeout: ReturnType<typeof setTimeout>;
		const cleanup = () => {
			clearTimeout(timeout);
			response.off("drain", onDrain);
			response.off("close", onClose);
		};
		const onDrain = () => {
			cleanup();
			resolve("drain");
		};
		const onClose = () => {
			cleanup();
			resolve("closed");
		};
		timeout = setTimeout(() => {
			cleanup();
			resolve("timeout");
		}, timeoutMs);

		response.once("drain", onDrain);
		response.once("close", onClose);
	});
}

export function resolveHttpByteRange(
	rangeHeader: string,
	fileSize: number,
): { start: number; end: number } | null {
	const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
	if (!match || (!match[1] && !match[2])) {
		return null;
	}

	if (fileSize === 0) {
		return null;
	}

	if (!match[1] && match[2]) {
		// Suffix range: bytes=-500
		const suffixLength = Number.parseInt(match[2], 10);
		if (Number.isNaN(suffixLength) || suffixLength <= 0) {
			return null;
		}

		return {
			start: Math.max(0, fileSize - suffixLength),
			end: fileSize - 1,
		};
	}

	const start = Number.parseInt(match[1], 10);
	if (Number.isNaN(start) || start < 0 || start >= fileSize) {
		return null;
	}

	const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
	if (Number.isNaN(requestedEnd) || requestedEnd < start) {
		return null;
	}

	return {
		start,
		end: Math.min(requestedEnd, fileSize - 1),
	};
}

async function resolveRealPath(filePath: string): Promise<string | null> {
	try {
		return await fs.realpath(path.resolve(filePath));
	} catch {
		return null;
	}
}

export function isAllowedMediaPath(realPath: string): boolean {
	return approvedLocalReadPaths.has(realPath);
}

export function registerMjpegPreviewStream(streamId: string, framePaths: string[]): void {
	if (!streamId || framePaths.length === 0) {
		return;
	}

	mjpegPreviewStreams.set(streamId, {
		allowedPaths: new Set(framePaths.map((framePath) => path.resolve(framePath))),
		framesBySequence: new Map(),
		latestFrame: null,
		subscribers: new Set(),
	});
}

function rememberMjpegPreviewSnapshot(
	stream: MjpegPreviewStreamState,
	frame: MjpegPreviewFrame,
): void {
	stream.framesBySequence.set(frame.sequence, frame);
	while (stream.framesBySequence.size > mjpegPreviewSnapshotHistoryLimit) {
		const oldestSequence = stream.framesBySequence.keys().next().value;
		if (typeof oldestSequence !== "number") {
			break;
		}
		stream.framesBySequence.delete(oldestSequence);
	}
}

export function unregisterMjpegPreviewStream(streamId: string | null | undefined): void {
	if (!streamId) {
		return;
	}

	const stream = mjpegPreviewStreams.get(streamId);
	mjpegPreviewStreams.delete(streamId);
	if (!stream) {
		return;
	}

	for (const subscriber of stream.subscribers) {
		subscriber.close();
	}
	stream.subscribers.clear();
}

export function publishMjpegPreviewFrame(
	streamId: string | null | undefined,
	framePath: string,
	sequence: number,
): boolean {
	if (!streamId || !Number.isFinite(sequence) || sequence <= 0) {
		return false;
	}

	const stream = mjpegPreviewStreams.get(streamId);
	if (!stream) {
		return false;
	}

	const resolvedPath = path.resolve(framePath);
	if (!stream.allowedPaths.has(resolvedPath) || !approvedLocalReadPaths.has(resolvedPath)) {
		return false;
	}

	if (stream.latestFrame && sequence <= stream.latestFrame.sequence) {
		return false;
	}

	let data: Buffer;
	try {
		data = readFileSync(resolvedPath);
	} catch {
		return false;
	}

	const frame = { data, path: resolvedPath, sequence };
	stream.latestFrame = frame;
	rememberMjpegPreviewSnapshot(stream, frame);
	for (const subscriber of stream.subscribers) {
		subscriber.requestWriteLatestFrame();
	}
	return true;
}

function parsePositiveIntegerQueryParam(value: string | null): number | null {
	if (!value || !/^\d+$/.test(value)) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function handleMjpegPreviewRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	const corsHeaders = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Credentials": "false",
	};

	if (request.method === "OPTIONS") {
		response.writeHead(204, {
			...corsHeaders,
			"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
			"Access-Control-Allow-Headers": "Range",
		});
		response.end();
		return;
	}

	const streamId = url.searchParams.get("streamId");
	const stream = streamId ? mjpegPreviewStreams.get(streamId) : null;
	if (!stream) {
		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Not Found");
		return;
	}
	const activeStreamId = streamId;
	if (!activeStreamId) {
		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Not Found");
		return;
	}

	response.writeHead(200, {
		...corsHeaders,
		"Content-Type": `multipart/x-mixed-replace; boundary=${mjpegBoundary}`,
		"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
		Pragma: "no-cache",
		Expires: "0",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	response.socket?.setNoDelay(true);
	response.flushHeaders?.();

	if (request.method === "HEAD") {
		response.end();
		return;
	}

	let closed = false;
	let inFlight = false;
	let lastSentSequence = 0;
	let lastSentAtMs = 0;
	let interval: ReturnType<typeof setInterval> | null = null;
	let scheduledWriteTimer: ReturnType<typeof setTimeout> | null = null;
	let subscriber: MjpegPreviewSubscriber;

	const cleanup = () => {
		if (closed) {
			return;
		}
		closed = true;
		stream.subscribers.delete(subscriber);
		if (scheduledWriteTimer !== null) {
			clearTimeout(scheduledWriteTimer);
			scheduledWriteTimer = null;
		}
		if (interval !== null) {
			clearInterval(interval);
			interval = null;
		}
	};

	const getNextWriteDelayMs = () => {
		if (lastSentSequence === 0) {
			return 0;
		}

		const elapsedMs = Date.now() - lastSentAtMs;
		return Math.max(0, mjpegPreviewMinWriteIntervalMs - elapsedMs);
	};

	const writeLatestFrame = async () => {
		if (scheduledWriteTimer !== null) {
			clearTimeout(scheduledWriteTimer);
			scheduledWriteTimer = null;
		}
		if (closed || inFlight) {
			return;
		}

		if (mjpegPreviewStreams.get(activeStreamId) !== stream) {
			cleanup();
			if (!response.destroyed) {
				response.end();
			}
			return;
		}

		const frame = stream.latestFrame;
		if (!frame || frame.sequence <= lastSentSequence) {
			return;
		}

		if (!stream.allowedPaths.has(frame.path) || !approvedLocalReadPaths.has(frame.path)) {
			return;
		}

		inFlight = true;
		try {
			if (closed || frame.sequence <= lastSentSequence) {
				return;
			}

			const headerWritten = response.write(
				`--${mjpegBoundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.data.length}\r\nX-Recordly-Sequence: ${frame.sequence}\r\n\r\n`,
			);
			const frameWritten = response.write(frame.data);
			const trailerWritten = response.write("\r\n");
			lastSentSequence = frame.sequence;
			lastSentAtMs = Date.now();
			if (!headerWritten || !frameWritten || !trailerWritten) {
				const result = await waitForMjpegResponseDrain(response);
				if (result === "timeout" && !closed && !response.destroyed) {
					cleanup();
					response.destroy();
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				console.warn("[media-server] Failed to stream native webcam preview frame:", error);
			}
		} finally {
			inFlight = false;
			if (!closed && stream.latestFrame && stream.latestFrame.sequence > lastSentSequence) {
				requestWriteLatestFrame();
			}
		}
	};

	const requestWriteLatestFrame = () => {
		if (closed || inFlight || scheduledWriteTimer !== null) {
			return;
		}

		const delayMs = getNextWriteDelayMs();
		if (delayMs <= 0) {
			setImmediate(() => {
				void writeLatestFrame();
			});
			return;
		}

		scheduledWriteTimer = setTimeout(() => {
			scheduledWriteTimer = null;
			void writeLatestFrame();
		}, delayMs);
	};

	subscriber = {
		response,
		requestWriteLatestFrame,
		close: () => {
			cleanup();
			if (!response.destroyed) {
				response.end();
			}
		},
	};
	interval = setInterval(() => {
		requestWriteLatestFrame();
	}, mjpegPreviewFallbackPollMs);
	stream.subscribers.add(subscriber);
	request.on("close", cleanup);
	response.on("close", cleanup);
	requestWriteLatestFrame();
}

async function handleMjpegPreviewSnapshotRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<void> {
	const corsHeaders = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Credentials": "false",
	};

	if (request.method === "OPTIONS") {
		response.writeHead(204, {
			...corsHeaders,
			"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
			"Access-Control-Allow-Headers": "Range",
		});
		response.end();
		return;
	}

	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, {
			...corsHeaders,
			"Content-Type": "text/plain; charset=utf-8",
		});
		response.end("Method Not Allowed");
		return;
	}

	const requestedSequence = parsePositiveIntegerQueryParam(url.searchParams.get("seq"));
	if (requestedSequence === null) {
		response.writeHead(400, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
		response.end("Missing valid seq parameter");
		return;
	}

	const streamId = url.searchParams.get("streamId");
	const stream = streamId ? mjpegPreviewStreams.get(streamId) : null;
	const latestFrame = stream?.latestFrame ?? null;
	if (!stream || !latestFrame) {
		response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
		response.end("Not Found");
		return;
	}

	if (latestFrame.sequence < requestedSequence) {
		response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
		response.end("Frame Not Ready");
		return;
	}

	const requestedFrame = stream.framesBySequence.get(requestedSequence);
	if (!requestedFrame) {
		response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
		response.end("Frame Expired");
		return;
	}

	response.writeHead(200, {
		...corsHeaders,
		"Content-Type": "image/jpeg",
		"Content-Length": requestedFrame.data.length,
		"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
		Pragma: "no-cache",
		Expires: "0",
		"X-Recordly-Sequence": requestedFrame.sequence,
	});
	if (request.method === "HEAD") {
		response.end();
		return;
	}

	response.end(requestedFrame.data);
}

async function handleMediaRequest(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");

		if (url.pathname === "/mjpeg-preview") {
			await handleMjpegPreviewRequest(request, response, url);
			return;
		}

		if (url.pathname === "/mjpeg-preview-snapshot") {
			await handleMjpegPreviewSnapshotRequest(request, response, url);
			return;
		}

		if (url.pathname !== "/video") {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not Found");
			return;
		}

		const rawPath = url.searchParams.get("path");
		if (!rawPath) {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Missing path parameter");
			return;
		}

		const resolvedPath = await resolveRealPath(rawPath);
		if (!resolvedPath || !isAllowedMediaPath(resolvedPath)) {
			console.warn(`[media-server] Blocked access to unapproved path: ${rawPath}`);
			response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Forbidden");
			return;
		}

		const stat = await fs.stat(resolvedPath);
		if (!stat.isFile()) {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not Found");
			return;
		}

		const contentType = getMediaContentType(resolvedPath);
		const fileSize = stat.size;
		const rangeHeader = request.headers.range;

		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Credentials": "false",
			"Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
		};

		if (request.method === "OPTIONS") {
			response.writeHead(204, {
				...corsHeaders,
				"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
				"Access-Control-Allow-Headers": "Range",
			});
			response.end();
			return;
		}

		if (rangeHeader) {
			if (fileSize === 0) {
				response.writeHead(416, { ...corsHeaders, "Content-Range": `bytes */0` });
				response.end();
				return;
			}

			const byteRange = resolveHttpByteRange(rangeHeader, fileSize);
			if (!byteRange) {
				response.writeHead(416, { ...corsHeaders, "Content-Range": `bytes */${fileSize}` });
				response.end();
				return;
			}

			const { start, end } = byteRange;

			const chunkSize = end - start + 1;
			response.writeHead(206, {
				...corsHeaders,
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Accept-Ranges": "bytes",
				"Content-Length": String(chunkSize),
				"Content-Type": contentType,
				"Cache-Control": "no-cache",
			});

			if (request.method === "HEAD") {
				response.end();
				return;
			}

			const stream = createReadStream(resolvedPath, { start, end });
			stream.pipe(response);
			stream.on("error", () => {
				if (!response.headersSent) {
					response.writeHead(500, { "Content-Type": "text/plain" });
				}
				response.end();
			});
		} else {
			response.writeHead(200, {
				...corsHeaders,
				"Accept-Ranges": "bytes",
				"Content-Length": String(fileSize),
				"Content-Type": contentType,
				"Cache-Control": "no-cache",
			});

			if (request.method === "HEAD") {
				response.end();
				return;
			}

			const stream = createReadStream(resolvedPath);
			stream.pipe(response);
			stream.on("error", () => {
				if (!response.headersSent) {
					response.writeHead(500, { "Content-Type": "text/plain" });
				}
				response.end();
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not Found");
			return;
		}

		console.error("[media-server] Error handling request:", error);
		response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Internal Server Error");
	}
}

export function getMediaServerBaseUrl(): string | null {
	return mediaServerBaseUrl;
}

export async function ensureMediaServer(): Promise<string> {
	if (mediaServerBaseUrl) {
		return mediaServerBaseUrl;
	}

	if (mediaServerStartPromise) {
		return mediaServerStartPromise;
	}

	mediaServerStartPromise = new Promise((resolve, reject) => {
		const server = createServer((request, response) => {
			void handleMediaRequest(request, response);
		});

		server.once("error", (error) => {
			reject(error);
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Media server did not expose a TCP address"));
				return;
			}

			mediaServerBaseUrl = `http://127.0.0.1:${address.port}`;
			console.log(`[media-server] Listening at ${mediaServerBaseUrl}`);
			resolve(mediaServerBaseUrl);
		});
	});

	return mediaServerStartPromise;
}

export function buildMediaUrl(baseUrl: string, filePath: string): string {
	const resolved = path.resolve(filePath);
	return `${baseUrl}/video?path=${encodeURIComponent(resolved)}`;
}

export function buildMjpegPreviewStreamUrl(baseUrl: string, streamId: string): string {
	return `${baseUrl}/mjpeg-preview?streamId=${encodeURIComponent(streamId)}`;
}

export function buildMjpegPreviewSnapshotUrl(baseUrl: string, streamId: string): string {
	return `${baseUrl}/mjpeg-preview-snapshot?streamId=${encodeURIComponent(streamId)}`;
}

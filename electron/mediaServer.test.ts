import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("media server path policy", () => {
	let tempRoot: string;
	let appDataPath: string;
	let userDataPath: string;
	let tempPath: string;
	let appPath: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-media-server-"));
		appDataPath = path.join(tempRoot, "AppData");
		userDataPath = path.join(tempRoot, "UserData");
		tempPath = path.join(tempRoot, "Temp");
		appPath = path.join(tempRoot, "App");

		await Promise.all(
			[appDataPath, userDataPath, tempPath, appPath].map((dirPath) =>
				fs.mkdir(dirPath, { recursive: true }),
			),
		);

		vi.resetModules();
		vi.doMock("electron", () => ({
			app: {
				isPackaged: false,
				getAppPath: () => appPath,
				getPath: (name: string) => {
					if (name === "appData") return appDataPath;
					if (name === "userData") return userDataPath;
					if (name === "temp") return tempPath;
					return tempRoot;
				},
				setPath: () => undefined,
			},
		}));
	});

	afterEach(async () => {
		vi.resetModules();
		vi.doUnmock("electron");
		if (tempRoot) {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("rejects existing media files outside the session directories until they are approved", async () => {
		const downloadsPath = path.join(tempRoot, "Downloads");
		const videoPath = path.join(downloadsPath, "personal-video.mp4");
		await fs.mkdir(downloadsPath, { recursive: true });
		await fs.writeFile(videoPath, "test-video");

		const { isAllowedMediaPath } = await import("./mediaServer");
		const { rememberApprovedLocalReadPath } = await import("./ipc/project/manager");

		expect(isAllowedMediaPath(videoPath)).toBe(false);

		await rememberApprovedLocalReadPath(videoPath);

		expect(isAllowedMediaPath(videoPath)).toBe(true);
	});

	it("rejects missing media files outside the allowed directories", async () => {
		const missingPath = path.join(tempRoot, "Downloads", "missing.mp4");
		const { isAllowedMediaPath } = await import("./mediaServer");

		expect(isAllowedMediaPath(missingPath)).toBe(false);
	});
});

describe("resolveHttpByteRange", () => {
	it("rejects malformed and multi-range headers", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=0-1,2-3", 100)).toBeNull();
		expect(resolveHttpByteRange("bytes=0-1foo", 100)).toBeNull();
	});

	it("clamps oversized explicit end offsets to EOF", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=0-9999999999", 3_221_225_472)).toEqual({
			start: 0,
			end: 3_221_225_471,
		});
	});

	it("rejects ranges that start beyond EOF", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=500-999", 500)).toBeNull();
	});

	it("preserves suffix range semantics", async () => {
		const { resolveHttpByteRange } = await import("./mediaServer");

		expect(resolveHttpByteRange("bytes=-500", 1_000)).toEqual({
			start: 500,
			end: 999,
		});
	});
});

describe("native webcam MJPEG preview stream registry", () => {
	async function readWithTimeout(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		timeoutMs = 500,
	) {
		let timeout: ReturnType<typeof setTimeout> | null = null;
		try {
			return await Promise.race([
				reader.read(),
				new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error("Timed out waiting for MJPEG stream read")),
						timeoutMs,
					);
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}
	}

	it("publishes only approved frame paths from the registered stream ring", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewStreamUrl,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-1";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePaths = [
			path.join(streamRoot, "preview-0.jpg"),
			path.join(streamRoot, "preview-1.jpg"),
		];
		registerMjpegPreviewStream(streamId, framePaths);
		try {
			await fs.writeFile(framePaths[0], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
			await fs.writeFile(framePaths[1], Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));

			expect(buildMjpegPreviewStreamUrl("http://127.0.0.1:1234", streamId)).toBe(
				"http://127.0.0.1:1234/mjpeg-preview?streamId=recording-1",
			);
			expect(publishMjpegPreviewFrame(streamId, framePaths[0], 1)).toBe(false);

			approvedLocalReadPaths.add(path.resolve(framePaths[0]));
			expect(publishMjpegPreviewFrame(streamId, framePaths[0], 1)).toBe(true);
			expect(publishMjpegPreviewFrame(streamId, framePaths[0], 1)).toBe(false);
			expect(publishMjpegPreviewFrame(streamId, framePaths[0], 0)).toBe(false);
			expect(publishMjpegPreviewFrame(streamId, "/tmp/outside.jpg", 2)).toBe(false);
			approvedLocalReadPaths.add(path.resolve(framePaths[1]));
			expect(publishMjpegPreviewFrame(streamId, framePaths[1], 2)).toBe(true);

			unregisterMjpegPreviewStream(streamId);
			expect(publishMjpegPreviewFrame(streamId, framePaths[0], 3)).toBe(false);
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePaths[0]));
			approvedLocalReadPaths.delete(path.resolve(framePaths[1]));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("streams the bytes captured at publish time even if a ring slot is overwritten", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewStreamUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-stream-snapshot";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		const acceptedFrameBytes = Buffer.from("accepted-frame-for-sequence-1", "utf8");
		const overwrittenFrameBytes = Buffer.from("overwritten-ring-slot-frame", "utf8");
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);
		try {
			await fs.writeFile(framePath, acceptedFrameBytes);
			expect(publishMjpegPreviewFrame(streamId, framePath, 1)).toBe(true);
			await fs.writeFile(framePath, overwrittenFrameBytes);

			const baseUrl = await ensureMediaServer();
			const response = await fetch(buildMjpegPreviewStreamUrl(baseUrl, streamId));
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			expect(reader).toBeTruthy();
			try {
				let body = "";
				for (
					let index = 0;
					index < 5 && !body.includes("X-Recordly-Sequence: 1");
					index += 1
				) {
					const { done, value } = await readWithTimeout(reader!);
					if (done || !value) {
						break;
					}
					body += Buffer.from(value).toString("latin1");
				}

				expect(body).toContain("X-Recordly-Sequence: 1");
				expect(body).toContain("accepted-frame-for-sequence-1");
				expect(body).not.toContain("overwritten-ring-slot-frame");
			} finally {
				await reader?.cancel().catch(() => undefined);
			}
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("serves latest accepted snapshot bytes without rereading overwritten ring slots", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewSnapshotUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-snapshot";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		const acceptedFrameBytes = Buffer.from([0xff, 0xd8, 0x41, 0xff, 0xd9]);
		const overwrittenFrameBytes = Buffer.from([0xff, 0xd8, 0x42, 0xff, 0xd9]);
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);
		try {
			await fs.writeFile(framePath, acceptedFrameBytes);
			expect(publishMjpegPreviewFrame(streamId, framePath, 9)).toBe(true);
			await fs.writeFile(framePath, overwrittenFrameBytes);

			const baseUrl = await ensureMediaServer();
			const response = await fetch(
				`${buildMjpegPreviewSnapshotUrl(baseUrl, streamId)}&seq=9`,
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("image/jpeg");
			expect(response.headers.get("x-recordly-sequence")).toBe("9");
			expect(Buffer.from(await response.arrayBuffer())).toEqual(acceptedFrameBytes);
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("serves the requested snapshot sequence instead of the newer latest frame", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewSnapshotUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-snapshot-exact-sequence";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		const requestedFrameBytes = Buffer.from([0xff, 0xd8, 0x31, 0xff, 0xd9]);
		const newerFrameBytes = Buffer.from([0xff, 0xd8, 0x32, 0xff, 0xd9]);
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);
		try {
			await fs.writeFile(framePath, requestedFrameBytes);
			expect(publishMjpegPreviewFrame(streamId, framePath, 9)).toBe(true);
			await fs.writeFile(framePath, newerFrameBytes);
			expect(publishMjpegPreviewFrame(streamId, framePath, 10)).toBe(true);

			const baseUrl = await ensureMediaServer();
			const response = await fetch(
				`${buildMjpegPreviewSnapshotUrl(baseUrl, streamId)}&seq=9`,
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("x-recordly-sequence")).toBe("9");
			expect(Buffer.from(await response.arrayBuffer())).toEqual(requestedFrameBytes);
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("requires a valid accepted snapshot sequence before serving preview bytes", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewSnapshotUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-snapshot-sequence";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);
		try {
			await fs.writeFile(framePath, Buffer.from([0xff, 0xd8, 0x55, 0xff, 0xd9]));
			expect(publishMjpegPreviewFrame(streamId, framePath, 4)).toBe(true);

			const baseUrl = await ensureMediaServer();
			const snapshotUrl = buildMjpegPreviewSnapshotUrl(baseUrl, streamId);
			await expect(fetch(snapshotUrl).then((response) => response.status)).resolves.toBe(400);
			await expect(
				fetch(`${snapshotUrl}&seq=not-a-number`).then((response) => response.status),
			).resolves.toBe(400);
			await expect(
				fetch(`${snapshotUrl}&seq=0`).then((response) => response.status),
			).resolves.toBe(400);
			await expect(
				fetch(`${snapshotUrl}&seq=5`).then((response) => response.status),
			).resolves.toBe(404);
			await expect(
				fetch(`${snapshotUrl}&seq=4`).then((response) => response.status),
			).resolves.toBe(200);
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("serves the latest accepted frame as a multipart MJPEG response", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewStreamUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-stream";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);
		try {
			await fs.writeFile(framePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
			expect(publishMjpegPreviewFrame(streamId, framePath, 7)).toBe(true);

			const baseUrl = await ensureMediaServer();
			const response = await fetch(buildMjpegPreviewStreamUrl(baseUrl, streamId));
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("multipart/x-mixed-replace");

			const reader = response.body?.getReader();
			expect(reader).toBeTruthy();
			try {
				let body = "";
				for (
					let index = 0;
					index < 5 && !body.includes("X-Recordly-Sequence: 7");
					index += 1
				) {
					const { done, value } = await readWithTimeout(reader!);
					if (done || !value) {
						break;
					}
					body += Buffer.from(value).toString("latin1");
				}

				expect(body).toContain("--recordly-native-webcam-preview");
				expect(body).toContain("Content-Type: image/jpeg");
				expect(body).toContain("X-Recordly-Sequence: 7");
			} finally {
				await reader?.cancel().catch(() => undefined);
			}
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("pushes newly published frames to connected MJPEG clients", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewStreamUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-stream-live-push";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);
		try {
			const baseUrl = await ensureMediaServer();
			const response = await fetch(buildMjpegPreviewStreamUrl(baseUrl, streamId));
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			expect(reader).toBeTruthy();
			try {
				await fs.writeFile(framePath, Buffer.from("live-pushed-frame", "utf8"));
				expect(publishMjpegPreviewFrame(streamId, framePath, 11)).toBe(true);

				let body = "";
				for (
					let index = 0;
					index < 5 && !body.includes("X-Recordly-Sequence: 11");
					index += 1
				) {
					const { done, value } = await readWithTimeout(reader!, 250);
					if (done || !value) {
						break;
					}
					body += Buffer.from(value).toString("latin1");
				}

				expect(body).toContain("X-Recordly-Sequence: 11");
				expect(body).toContain("live-pushed-frame");
			} finally {
				await reader?.cancel().catch(() => undefined);
			}
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("coalesces burst preview frames so clients skip to the newest accepted frame", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewStreamUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-stream-live-coalesce";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);

		const readUntil = async (
			reader: ReadableStreamDefaultReader<Uint8Array>,
			pattern: string,
		) => {
			let body = "";
			for (let index = 0; index < 10 && !body.includes(pattern); index += 1) {
				const { done, value } = await readWithTimeout(reader, 500);
				if (done || !value) {
					break;
				}
				body += Buffer.from(value).toString("latin1");
			}
			return body;
		};

		try {
			const baseUrl = await ensureMediaServer();
			const response = await fetch(buildMjpegPreviewStreamUrl(baseUrl, streamId));
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			expect(reader).toBeTruthy();
			try {
				await fs.writeFile(framePath, Buffer.from("live-frame-one", "utf8"));
				expect(publishMjpegPreviewFrame(streamId, framePath, 1)).toBe(true);
				const firstBody = await readUntil(reader!, "X-Recordly-Sequence: 1");
				expect(firstBody).toContain("X-Recordly-Sequence: 1");

				await fs.writeFile(framePath, Buffer.from("live-frame-two", "utf8"));
				expect(publishMjpegPreviewFrame(streamId, framePath, 2)).toBe(true);
				await new Promise((resolve) => setImmediate(resolve));
				await fs.writeFile(framePath, Buffer.from("live-frame-three", "utf8"));
				expect(publishMjpegPreviewFrame(streamId, framePath, 3)).toBe(true);

				const nextBody = await readUntil(reader!, "X-Recordly-Sequence: 3");
				expect(nextBody).not.toContain("X-Recordly-Sequence: 2");
				expect(nextBody).toContain("X-Recordly-Sequence: 3");
				expect(nextBody).not.toContain("live-frame-two");
				expect(nextBody).toContain("live-frame-three");
			} finally {
				await reader?.cancel().catch(() => undefined);
			}
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});

	it("ends active MJPEG clients when a preview stream is unregistered", async () => {
		const { approvedLocalReadPaths } = await import("./ipc/state");
		const {
			buildMjpegPreviewStreamUrl,
			ensureMediaServer,
			publishMjpegPreviewFrame,
			registerMjpegPreviewStream,
			unregisterMjpegPreviewStream,
		} = await import("./mediaServer");

		const streamId = "recording-http-stream-unregister";
		const streamRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mjpeg-preview-"));
		const framePath = path.join(streamRoot, "preview-0.jpg");
		approvedLocalReadPaths.add(path.resolve(framePath));
		registerMjpegPreviewStream(streamId, [framePath]);
		try {
			await fs.writeFile(framePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
			expect(publishMjpegPreviewFrame(streamId, framePath, 1)).toBe(true);

			const baseUrl = await ensureMediaServer();
			const response = await fetch(buildMjpegPreviewStreamUrl(baseUrl, streamId));
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			expect(reader).toBeTruthy();

			try {
				let body = "";
				for (
					let index = 0;
					index < 5 && !body.includes("X-Recordly-Sequence: 1");
					index += 1
				) {
					const { done, value } = await readWithTimeout(reader!);
					if (done || !value) {
						break;
					}
					body += Buffer.from(value).toString("latin1");
				}
				expect(body).toContain("X-Recordly-Sequence: 1");

				unregisterMjpegPreviewStream(streamId);
				let streamEnded = false;
				for (let index = 0; index < 3 && !streamEnded; index += 1) {
					const finalRead = await readWithTimeout(reader!);
					streamEnded = finalRead.done === true;
				}
				expect(streamEnded).toBe(true);
			} finally {
				await reader?.cancel().catch(() => undefined);
			}
		} finally {
			unregisterMjpegPreviewStream(streamId);
			approvedLocalReadPaths.delete(path.resolve(framePath));
			await fs.rm(streamRoot, { recursive: true, force: true });
		}
	});
});

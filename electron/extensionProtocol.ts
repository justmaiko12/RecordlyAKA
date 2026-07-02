/**
 * recordly-ext:// protocol — serves extension files (modules, wallpapers,
 * icons, cursors, sounds) to the renderer now that webSecurity is enabled and
 * raw file:// subresources are blocked on http-served pages.
 *
 * URL shape: recordly-ext://local/<absolute path> (Windows: /C:/Users/...).
 * The handler only serves regular files whose real path stays inside the
 * user-installed or built-in extensions directories, so it cannot be used as
 * a generic local file oracle even from a compromised renderer.
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import {
	getBuiltinExtensionsDirectory,
	getExtensionsDirectory,
} from "./extensions/extensionLoader";
import { resolveHttpByteRange } from "./mediaServer";

export const EXTENSION_PROTOCOL_SCHEME = "recordly-ext";

const CONTENT_TYPES: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

/**
 * Must run before app.whenReady(). standard+secure lets the scheme behave as
 * a first-class origin (relative URL resolution, secure-context checks);
 * supportFetchAPI+corsEnabled are required for dynamic import() and fetch()
 * from the http-served renderer; stream keeps large video responses cheap.
 */
export function registerExtensionProtocolPrivileges(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: EXTENSION_PROTOCOL_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				corsEnabled: true,
				stream: true,
			},
		},
	]);
}

function decodeRequestedPath(requestUrl: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(requestUrl);
	} catch {
		return null;
	}

	if (parsed.hostname !== "local") {
		return null;
	}

	let pathname: string;
	try {
		pathname = decodeURIComponent(parsed.pathname);
	} catch {
		return null;
	}

	// Windows drive paths arrive as /C:/Users/...
	if (/^\/[A-Za-z]:\//.test(pathname)) {
		pathname = pathname.slice(1);
	}

	return pathname || null;
}

async function resolveAllowedRoots(): Promise<string[]> {
	const roots: string[] = [];
	for (const dir of [getExtensionsDirectory(), getBuiltinExtensionsDirectory()]) {
		try {
			roots.push(await fs.realpath(dir));
		} catch {
			// Directory may not exist yet (e.g. no user extensions installed).
		}
	}
	return roots;
}

function isInsideRoot(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function errorResponse(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

async function handleExtensionRequest(request: Request): Promise<Response> {
	const requestedPath = decodeRequestedPath(request.url);
	if (!requestedPath) {
		return errorResponse(400, "Bad Request");
	}

	// Canonicalize before the containment check so symlinks inside an
	// extension directory cannot point reads outside of it.
	let realPath: string;
	try {
		realPath = await fs.realpath(path.resolve(requestedPath));
	} catch {
		return errorResponse(404, "Not Found");
	}

	const roots = await resolveAllowedRoots();
	if (!roots.some((root) => isInsideRoot(realPath, root))) {
		console.warn(`[ext-protocol] Blocked access outside extension dirs: ${requestedPath}`);
		return errorResponse(403, "Forbidden");
	}

	const stat = await fs.stat(realPath).catch(() => null);
	if (!stat?.isFile()) {
		return errorResponse(404, "Not Found");
	}

	const contentType =
		CONTENT_TYPES[path.extname(realPath).toLowerCase()] ?? "application/octet-stream";
	const baseHeaders: Record<string, string> = {
		"Content-Type": contentType,
		"Access-Control-Allow-Origin": "*",
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-cache",
	};

	const rangeHeader = request.headers.get("range");
	if (rangeHeader) {
		const byteRange = resolveHttpByteRange(rangeHeader, stat.size);
		if (!byteRange) {
			return new Response(null, {
				status: 416,
				headers: { ...baseHeaders, "Content-Range": `bytes */${stat.size}` },
			});
		}

		const stream = Readable.toWeb(
			createReadStream(realPath, { start: byteRange.start, end: byteRange.end }),
		) as unknown as globalThis.ReadableStream;
		return new Response(stream, {
			status: 206,
			headers: {
				...baseHeaders,
				"Content-Range": `bytes ${byteRange.start}-${byteRange.end}/${stat.size}`,
				"Content-Length": String(byteRange.end - byteRange.start + 1),
			},
		});
	}

	const stream = Readable.toWeb(
		createReadStream(realPath),
	) as unknown as globalThis.ReadableStream;
	return new Response(stream, {
		status: 200,
		headers: { ...baseHeaders, "Content-Length": String(stat.size) },
	});
}

/** Must run after app.whenReady(). */
export function registerExtensionProtocolHandler(): void {
	protocol.handle(EXTENSION_PROTOCOL_SCHEME, async (request) => {
		try {
			return await handleExtensionRequest(request);
		} catch (error) {
			console.error("[ext-protocol] Error handling request:", error);
			return errorResponse(500, "Internal Server Error");
		}
	});
}

// Exported for tests.
export const _internal = { decodeRequestedPath, isInsideRoot };

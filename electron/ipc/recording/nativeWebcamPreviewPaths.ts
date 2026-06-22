import path from "node:path";

export const NATIVE_WEBCAM_PREVIEW_RING_SIZE = 8;

export function deriveNativeWebcamPreviewFramePaths(
	basePath: string,
	ringSize = NATIVE_WEBCAM_PREVIEW_RING_SIZE,
): string[] {
	const parsed = path.parse(basePath);
	const extension = parsed.ext || ".jpg";

	return Array.from({ length: ringSize }, (_, index) =>
		path.resolve(parsed.dir, `${parsed.name}-${index}${extension}`),
	);
}

export function resolveNativeWebcamPreviewFramePath(
	value: unknown,
	allowedPaths: ReadonlySet<string>,
): string | null {
	if (typeof value !== "string" || value.trim() === "") {
		return null;
	}

	const resolvedPath = path.resolve(value);
	return allowedPaths.has(resolvedPath) ? resolvedPath : null;
}

import path from "node:path";

export type NativeWebcamPreviewRendererIssuePayload = {
	surface?: unknown;
	issue?: unknown;
	previewUrl?: unknown;
	visibleStartedAtMs?: unknown;
	lastVisibleLoadAtMs?: unknown;
	nowMs?: unknown;
	recordingActive?: unknown;
	details?: unknown;
};

const MAX_STRING_LENGTH = 512;
const MAX_DETAIL_KEYS = 24;

function sanitizeString(value: unknown) {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.slice(0, MAX_STRING_LENGTH);
}

function sanitizeNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeBoolean(value: unknown) {
	return typeof value === "boolean" ? value : null;
}

function sanitizeDetailValue(value: unknown): string | number | boolean | null {
	if (typeof value === "string") {
		return value.slice(0, MAX_STRING_LENGTH);
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "boolean") {
		return value;
	}
	return null;
}

export function sanitizeNativeWebcamPreviewRendererIssuePayload(
	payload: NativeWebcamPreviewRendererIssuePayload,
): Record<string, unknown> {
	const details: Record<string, unknown> = {
		surface: sanitizeString(payload.surface) ?? "unknown",
		issue: sanitizeString(payload.issue) ?? "unknown",
	};

	const previewUrl = sanitizeString(payload.previewUrl);
	if (previewUrl) {
		details.previewUrl = previewUrl;
	}

	const visibleStartedAtMs = sanitizeNumber(payload.visibleStartedAtMs);
	if (visibleStartedAtMs !== null) {
		details.visibleStartedAtMs = visibleStartedAtMs;
	}

	const lastVisibleLoadAtMs = sanitizeNumber(payload.lastVisibleLoadAtMs);
	if (lastVisibleLoadAtMs !== null) {
		details.lastVisibleLoadAtMs = lastVisibleLoadAtMs;
	}

	const nowMs = sanitizeNumber(payload.nowMs);
	if (nowMs !== null) {
		details.nowMs = nowMs;
	}

	const recordingActive = sanitizeBoolean(payload.recordingActive);
	if (recordingActive !== null) {
		details.recordingActive = recordingActive;
	}

	if (payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)) {
		for (const [key, value] of Object.entries(payload.details).slice(0, MAX_DETAIL_KEYS)) {
			const sanitizedKey = sanitizeString(key);
			const sanitizedValue = sanitizeDetailValue(value);
			if (!sanitizedKey || sanitizedValue === null || sanitizedKey in details) {
				continue;
			}
			details[sanitizedKey] = sanitizedValue;
		}
	}

	return details;
}

export function resolveNativeWebcamPreviewRendererIssueTarget(videoPath: string | null | undefined) {
	if (typeof videoPath !== "string" || !videoPath.trim()) {
		return null;
	}

	const trimmedPath = videoPath.trim();
	const recordingsDir = path.dirname(trimmedPath);
	const baseName = path.basename(trimmedPath, path.extname(trimmedPath));
	const sessionId = baseName.startsWith("recording-")
		? baseName.slice("recording-".length)
		: baseName;

	if (!recordingsDir || !sessionId) {
		return null;
	}

	return { recordingsDir, sessionId };
}

import fs from "node:fs/promises";
import path from "node:path";

export type RecordingEventLogEntry = {
	timestamp: string;
	sessionId: string;
	event: string;
	details?: Record<string, unknown>;
};

function sanitizeSessionId(sessionId: string) {
	const trimmed = sessionId.trim();
	return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getRecordingEventLogPath(recordingsDir: string, sessionId: string) {
	const safeSessionId = sanitizeSessionId(sessionId);
	const baseName = safeSessionId.startsWith("recording-")
		? safeSessionId
		: `recording-${safeSessionId}`;
	return path.join(recordingsDir, `${baseName}.recordly-events.jsonl`);
}

export async function appendRecordingEventLogEntry({
	recordingsDir,
	sessionId,
	event,
	details,
}: {
	recordingsDir: string;
	sessionId: string;
	event: string;
	details?: Record<string, unknown>;
}) {
	const logPath = getRecordingEventLogPath(recordingsDir, sessionId);
	const entry: RecordingEventLogEntry = {
		timestamp: new Date().toISOString(),
		sessionId,
		event,
		...(details ? { details } : {}),
	};

	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
	return { logPath, entry };
}

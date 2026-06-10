import fs from "node:fs/promises";

export type WebcamLayoutMode = "screen" | "camera-full";

export interface WebcamLayoutEvent {
	timeMs: number;
	mode: WebcamLayoutMode;
}

let sessionEvents: WebcamLayoutEvent[] | null = null;

export function getWebcamLayoutEventsPath(videoPath: string): string {
	return `${videoPath}.webcam-layout-events.json`;
}

export function beginWebcamLayoutSession(): void {
	sessionEvents = [];
}

function isValidEvent(event: WebcamLayoutEvent): boolean {
	return (
		Number.isFinite(event?.timeMs) &&
		event.timeMs >= 0 &&
		(event.mode === "screen" || event.mode === "camera-full")
	);
}

export function recordWebcamLayoutEvent(event: WebcamLayoutEvent): void {
	if (!sessionEvents || !isValidEvent(event)) {
		return;
	}
	sessionEvents.push({ timeMs: Math.round(event.timeMs), mode: event.mode });
}

/**
 * Writes the sidecar next to a finalized video. No-op without events.
 *
 * Does NOT clear the session: finalize runs once per output file of the same
 * recording (the screen video AND the separate webcam video), and the editor
 * looks for the sidecar next to the screen video — every finalized file gets
 * a copy. The session is cleared by the next beginWebcamLayoutSession().
 */
export async function persistWebcamLayoutEvents(videoPath: string): Promise<void> {
	const events = sessionEvents;
	if (!events || events.length === 0) {
		return;
	}
	try {
		await fs.writeFile(
			getWebcamLayoutEventsPath(videoPath),
			JSON.stringify({ version: 1, events }),
			"utf8",
		);
	} catch (error) {
		console.warn("[webcam-layout] Failed to persist layout events:", error);
	}
}

export async function readWebcamLayoutEvents(videoPath: string): Promise<WebcamLayoutEvent[]> {
	try {
		const raw = await fs.readFile(getWebcamLayoutEventsPath(videoPath), "utf8");
		const parsed = JSON.parse(raw) as { events?: WebcamLayoutEvent[] };
		return Array.isArray(parsed.events) ? parsed.events.filter(isValidEvent) : [];
	} catch {
		return [];
	}
}

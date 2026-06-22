import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { appendRecordingEventLogEntry } from "./recordingEventLog";

const execFileAsync = promisify(execFile);
const WEBCAM_NORMALIZE_TIMEOUT_MS = 20 * 60 * 1000;

export type WebcamSidecarNormalizeResult = {
	path: string;
	normalized: boolean;
	error?: string;
	bytesBefore?: number;
	bytesAfter?: number;
};

function shouldNormalizeWebcamSidecar(filePath: string, mimeType?: string | null) {
	const normalizedMimeType = mimeType?.toLowerCase() ?? "";
	return normalizedMimeType.includes("video/mp4") || filePath.toLowerCase().endsWith(".mp4");
}

function buildTempPath(filePath: string) {
	const parsed = path.parse(filePath);
	return path.join(parsed.dir, `${parsed.name}.normalized-${Date.now()}${parsed.ext || ".mp4"}`);
}

export async function normalizeWebcamSidecarIfNeeded({
	recordingsDir,
	sessionId,
	filePath,
	mimeType,
}: {
	recordingsDir: string;
	sessionId: string;
	filePath: string;
	mimeType?: string | null;
}): Promise<WebcamSidecarNormalizeResult> {
	if (!shouldNormalizeWebcamSidecar(filePath, mimeType)) {
		return { path: filePath, normalized: false };
	}

	const tempPath = buildTempPath(filePath);
	let bytesBefore: number | undefined;

	try {
		bytesBefore = (await fs.stat(filePath)).size;
		await appendRecordingEventLogEntry({
			recordingsDir,
			sessionId,
			event: "webcam-sidecar-normalize-started",
			details: { filePath, mimeType: mimeType ?? null, bytesBefore },
		});

		const ffmpegPath = getFfmpegBinaryPath();
		await execFileAsync(
			ffmpegPath,
			[
				"-hide_banner",
				"-y",
				"-fflags",
				"+genpts",
				"-i",
				filePath,
				"-map",
				"0:v:0",
				"-an",
				"-vf",
				"fps=30",
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"23",
				"-pix_fmt",
				"yuv420p",
				"-movflags",
				"+faststart",
				"-avoid_negative_ts",
				"make_zero",
				tempPath,
			],
			{
				timeout: WEBCAM_NORMALIZE_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
			},
		);

		const bytesAfter = (await fs.stat(tempPath)).size;
		if (bytesAfter <= 0) {
			throw new Error("Normalized webcam sidecar is empty");
		}

		await fs.rename(tempPath, filePath);
		await appendRecordingEventLogEntry({
			recordingsDir,
			sessionId,
			event: "webcam-sidecar-normalize-finished",
			details: { filePath, bytesBefore: bytesBefore ?? null, bytesAfter },
		});

		return {
			path: filePath,
			normalized: true,
			bytesBefore,
			bytesAfter,
		};
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		const message = error instanceof Error ? error.message : String(error);
		await appendRecordingEventLogEntry({
			recordingsDir,
			sessionId,
			event: "webcam-sidecar-normalize-failed",
			details: { filePath, mimeType: mimeType ?? null, error: message },
		}).catch(() => undefined);

		return {
			path: filePath,
			normalized: false,
			error: message,
			bytesBefore,
		};
	}
}

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getDefaultRecordingsDir() {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Recordly", "recordings")
    : path.join(os.homedir(), ".recordly", "recordings");
}

function isMainRecordingFile(fileName) {
  return /^recording-\d+\.mp4$/u.test(fileName);
}

async function findLatestRecording(recordingsDir) {
  const entries = await fs.readdir(recordingsDir, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isMainRecordingFile(entry.name))
      .map(async (entry) => {
        const filePath = path.join(recordingsDir, entry.name);
        const stat = await fs.stat(filePath);
        return { filePath, mtimeMs: stat.mtimeMs };
      }),
  );

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath ?? null;
}

async function main() {
  const recordingsDir =
    process.env.RECORDLY_RECORDINGS_DIR?.trim() || getDefaultRecordingsDir();
  const latestRecordingPath = await findLatestRecording(recordingsDir);
  if (!latestRecordingPath) {
    console.error(`No main Recordly recording found in: ${recordingsDir}`);
    process.exit(2);
  }

  console.log(`Auditing latest Recordly recording: ${latestRecordingPath}`);
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const auditScriptPath = path.join(currentDir, "audit-recording-run.mjs");
  const child = spawn(process.execPath, [auditScriptPath, latestRecordingPath], {
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`Recording audit terminated by signal: ${signal}`);
      process.exit(2);
    }
    process.exit(code ?? 2);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

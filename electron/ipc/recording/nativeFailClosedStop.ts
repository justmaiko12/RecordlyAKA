import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const NATIVE_FAIL_CLOSED_FORCE_KILL_AFTER_MS = 5_000;

type NativeFailClosedStopProcess = Pick<
	ChildProcessWithoutNullStreams,
	"killed" | "kill" | "once" | "stdin"
>;

export function shouldRequestNativeFailClosedHelperStop(
	details?: Record<string, unknown> | null,
): boolean {
	const action = typeof details?.action === "string" ? details.action : null;
	return action !== "stop-recording" && action !== "stopped-recording";
}

export function requestNativeFailClosedHelperStop({
	process,
	appendLog,
	setTimeoutFn = setTimeout,
	clearTimeoutFn = clearTimeout,
	forceKillAfterMs = NATIVE_FAIL_CLOSED_FORCE_KILL_AFTER_MS,
}: {
	process: NativeFailClosedStopProcess | null;
	appendLog?: (line: string) => void;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	forceKillAfterMs?: number;
}) {
	if (!process) {
		return { stopRequested: false, forceKillScheduled: false };
	}

	try {
		process.stdin.write("stop\n");
	} catch (error) {
		appendLog?.(`NATIVE_FAIL_CLOSED_STOP_WRITE_FAILED error=${String(error)}\n`);
		process.kill("SIGTERM");
		return { stopRequested: false, forceKillScheduled: false };
	}

	const timeout = setTimeoutFn(() => {
		if (!process.killed) {
			appendLog?.(
				`NATIVE_FAIL_CLOSED_FORCE_KILL reason=helper-did-not-exit-after-stop timeoutMs=${forceKillAfterMs}\n`,
			);
			process.kill("SIGTERM");
		}
	}, forceKillAfterMs);

	process.once("close", () => clearTimeoutFn(timeout));
	return { stopRequested: true, forceKillScheduled: true };
}

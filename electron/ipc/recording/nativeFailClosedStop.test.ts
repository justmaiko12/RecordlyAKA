import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	requestNativeFailClosedHelperStop,
	shouldRequestNativeFailClosedHelperStop,
} from "./nativeFailClosedStop";

function createFakeProcess({ writeThrows = false } = {}) {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		killed: false,
		kill: vi.fn(function (this: { killed: boolean }, signal?: string) {
			this.killed = true;
			return true;
		}),
		stdin: {
			write: vi.fn(() => {
				if (writeThrows) {
					throw new Error("stdin closed");
				}
				return true;
			}),
		},
	});
}

describe("requestNativeFailClosedHelperStop", () => {
	it("does not request a duplicate stop when the helper is already self-stopping", () => {
		expect(shouldRequestNativeFailClosedHelperStop({ action: "stop-recording" })).toBe(false);
		expect(shouldRequestNativeFailClosedHelperStop({ action: "stopped-recording" })).toBe(
			false,
		);
		expect(shouldRequestNativeFailClosedHelperStop({ action: "disable-webcam" })).toBe(true);
		expect(shouldRequestNativeFailClosedHelperStop()).toBe(true);
	});

	it("requests a graceful helper stop first", () => {
		vi.useFakeTimers();
		const process = createFakeProcess();
		const appendLog = vi.fn();

		const result = requestNativeFailClosedHelperStop({
			process,
			appendLog,
			forceKillAfterMs: 5_000,
		});

		expect(result).toEqual({ stopRequested: true, forceKillScheduled: true });
		expect(process.stdin.write).toHaveBeenCalledWith("stop\n");
		expect(process.kill).not.toHaveBeenCalled();

		process.emit("close");
		vi.advanceTimersByTime(5_000);

		expect(process.kill).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("force-kills the helper if it ignores fail-closed stop", () => {
		vi.useFakeTimers();
		const process = createFakeProcess();
		const appendLog = vi.fn();

		requestNativeFailClosedHelperStop({
			process,
			appendLog,
			forceKillAfterMs: 5_000,
		});
		vi.advanceTimersByTime(5_000);

		expect(process.kill).toHaveBeenCalledWith("SIGTERM");
		expect(appendLog).toHaveBeenCalledWith(
			"NATIVE_FAIL_CLOSED_FORCE_KILL reason=helper-did-not-exit-after-stop timeoutMs=5000\n",
		);
		vi.useRealTimers();
	});

	it("kills immediately if the graceful stop command cannot be written", () => {
		const process = createFakeProcess({ writeThrows: true });
		const appendLog = vi.fn();

		const result = requestNativeFailClosedHelperStop({
			process,
			appendLog,
			forceKillAfterMs: 5_000,
		});

		expect(result).toEqual({ stopRequested: false, forceKillScheduled: false });
		expect(process.kill).toHaveBeenCalledWith("SIGTERM");
		expect(appendLog).toHaveBeenCalledWith(
			"NATIVE_FAIL_CLOSED_STOP_WRITE_FAILED error=Error: stdin closed\n",
		);
	});
});

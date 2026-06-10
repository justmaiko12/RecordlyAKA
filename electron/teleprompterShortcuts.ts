import { globalShortcut } from "electron";

export type TeleprompterCommand = "toggle-play" | "speed-down" | "speed-up";

const SCROLL_SHORTCUTS: Array<[string, TeleprompterCommand]> = [
	["Alt+F8", "toggle-play"],
	["Alt+F7", "speed-down"],
	["Alt+F9", "speed-up"],
];

const TOGGLE_SHORTCUT = "Alt+T";

/** Registered only while the teleprompter window exists. */
export function registerTeleprompterScrollShortcuts(
	send: (command: TeleprompterCommand) => void,
): void {
	for (const [accelerator, command] of SCROLL_SHORTCUTS) {
		try {
			const registered = globalShortcut.register(accelerator, () => send(command));
			if (!registered) {
				console.warn(`[teleprompter] Could not register global shortcut ${accelerator}`);
			}
		} catch (error) {
			console.warn(
				`[teleprompter] Could not register global shortcut ${accelerator}:`,
				error,
			);
		}
	}
}

export function unregisterTeleprompterScrollShortcuts(): void {
	for (const [accelerator] of SCROLL_SHORTCUTS) {
		try {
			globalShortcut.unregister(accelerator);
		} catch {
			// Best effort - shortcut may not have been registered.
		}
	}
}

/** Registered for the app lifetime so Alt+T can summon the window. */
export function registerTeleprompterToggleShortcut(toggle: () => void): void {
	try {
		const registered = globalShortcut.register(TOGGLE_SHORTCUT, toggle);
		if (!registered) {
			console.warn(`[teleprompter] Could not register global shortcut ${TOGGLE_SHORTCUT}`);
		}
	} catch (error) {
		console.warn(
			`[teleprompter] Could not register global shortcut ${TOGGLE_SHORTCUT}:`,
			error,
		);
	}
}

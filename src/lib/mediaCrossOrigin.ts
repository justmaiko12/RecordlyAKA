/**
 * With webSecurity enabled, cross-origin media (the loopback media server
 * runs on a different port than the page; extension assets load over
 * recordly-ext://) taints canvases and WebGL textures unless the element is
 * loaded in CORS mode. Both servers send Access-Control-Allow-Origin: *, so
 * "anonymous" is sufficient. file://, blob:, data:, and same-origin URLs must
 * NOT get the attribute — file:// has no CORS support and would fail to load.
 */
export function getMediaElementCrossOrigin(
	url: string | null | undefined,
): "anonymous" | undefined {
	if (!url) {
		return undefined;
	}

	if (url.startsWith("recordly-ext://")) {
		return "anonymous";
	}

	if (!/^https?:\/\//i.test(url)) {
		return undefined;
	}

	if (
		typeof window !== "undefined" &&
		window.location?.origin &&
		url.startsWith(`${window.location.origin}/`)
	) {
		return undefined;
	}

	return "anonymous";
}

/** Apply CORS mode to an element when (and only when) the URL needs it. */
export function applyMediaElementCrossOrigin(
	element: HTMLMediaElement | HTMLImageElement,
	url: string | null | undefined,
): void {
	const mode = getMediaElementCrossOrigin(url);
	if (mode) {
		element.crossOrigin = mode;
	}
}

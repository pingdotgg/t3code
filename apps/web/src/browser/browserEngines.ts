import type { PreviewBrowserEngine } from "@t3tools/contracts";

export const BROWSER_ENGINE_LABELS: Record<PreviewBrowserEngine, string> = {
  blink: "Chromium (Blink)",
  gecko: "Firefox (Gecko)",
  webkit: "Safari (WebKit)",
};

/** Blink already renders in the docked view, so only the other engines are offered. */
export function pickableBrowserEngines(
  engines: ReadonlyArray<PreviewBrowserEngine>,
): ReadonlyArray<PreviewBrowserEngine> {
  return engines.filter((engine) => engine !== "blink");
}

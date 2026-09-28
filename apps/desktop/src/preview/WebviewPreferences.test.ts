import { describe, expect, it } from "vite-plus/test";

import { PREVIEW_WEBVIEW_PREFERENCES } from "./WebviewPreferences.ts";

/**
 * Mirrors Electron's webview attribute parser closely enough to catch the
 * regressions we've already hit:
 *
 * - whitespace inside the comma-separated list silently drops keys (so
 *   `" sandbox=true"` becomes an unknown key and Electron falls back to
 *   defaults — re-opening the Node-leak window we closed),
 * - non-`true`/`false` values (`"yes"`, `"no"`, etc.) are kept as truthy
 *   strings and assigned to a boolean preference, which silently flips
 *   `contextIsolation=no` to ENABLED (then react-grab can't see the React
 *   DevTools hook and componentName resolution always returns null).
 *
 * The actual Electron parser does roughly:
 *
 *     for (const pair of webpreferences.split(',')) {
 *       const [key, value] = pair.split('=');
 *       prefs[key] = value;   // value left as a string
 *     }
 *
 * then later coerces booleans via `Boolean(value)`. Replicating that here
 * keeps the test independent of Electron internals while still failing if
 * we accidentally ship `"contextIsolation=no"` again.
 */
function parseWebPreferences(input: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of input.split(",")) {
    if (pair !== pair.trim()) {
      // Electron's parser doesn't trim; surface the bug as undefined-key.
      out[pair] = pair.split("=")[1];
      continue;
    }
    const [key, value] = pair.split("=");
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

describe("PREVIEW_WEBVIEW_PREFERENCES", () => {
  const parsed = parseWebPreferences(PREVIEW_WEBVIEW_PREFERENCES);

  it("contains exactly the three security-critical keys", () => {
    expect(parsed).toEqual({
      contextIsolation: "false",
      sandbox: "true",
      nodeIntegration: "false",
    });
  });
});

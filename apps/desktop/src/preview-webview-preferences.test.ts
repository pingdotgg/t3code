import { describe, expect, it } from "vitest";

import { PREVIEW_WEBVIEW_PREFERENCES } from "./preview-webview-preferences.ts";

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
    expect(Object.keys(parsed).toSorted()).toEqual(
      ["contextIsolation", "nodeIntegration", "sandbox"].toSorted(),
    );
  });

  it("uses canonical JS-boolean string literals (not yes/no, on/off, 1/0)", () => {
    // `value="no"` is a TRUTHY string when assigned to webPreferences.X — so
    // `contextIsolation="no"` would silently leave isolation ENABLED. Lock
    // the values to `"true"` / `"false"` so the parser does the right thing.
    for (const value of Object.values(parsed)) {
      expect(value).toMatch(/^(true|false)$/);
    }
  });

  it("disables context isolation (so react-grab can see the page's React DevTools hook)", () => {
    expect(parsed["contextIsolation"]).toBe("false");
  });

  it("keeps the renderer sandbox enabled (so the page cannot reach Node APIs)", () => {
    expect(parsed["sandbox"]).toBe("true");
  });

  it("disables nodeIntegration (defense in depth — page never gets Node)", () => {
    expect(parsed["nodeIntegration"]).toBe("false");
  });

  it("contains no whitespace (Electron's parser does not trim)", () => {
    // Electron splits on `,` without trimming, so any whitespace would turn
    // a key into an unknown one and silently drop the security flag.
    expect(PREVIEW_WEBVIEW_PREFERENCES).not.toMatch(/\s/);
  });
});

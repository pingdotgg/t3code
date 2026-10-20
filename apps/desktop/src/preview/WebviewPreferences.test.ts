import { describe, expect, it } from "vite-plus/test";

import { PREVIEW_WEBVIEW_PREFERENCES } from "./WebviewPreferences.ts";

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

  it("preserves guest security preferences and disables unsupported FedCM", () => {
    expect(parsed).toEqual({
      contextIsolation: "false",
      nodeIntegration: "false",
      sandbox: "true",
      disableBlinkFeatures: "FedCm",
    });
  });

  it("uses canonical JS-boolean string literals (not yes/no, on/off, 1/0)", () => {
    // `value="no"` is a TRUTHY string when assigned to webPreferences.X — so
    // `contextIsolation="no"` would silently leave isolation ENABLED. Lock
    // the values to `"true"` / `"false"` so the parser does the right thing.
    for (const key of ["contextIsolation", "nodeIntegration", "sandbox"]) {
      expect(parsed[key]).toMatch(/^(true|false)$/);
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
    expect(PREVIEW_WEBVIEW_PREFERENCES).not.toMatch(/\s/);
  });
});

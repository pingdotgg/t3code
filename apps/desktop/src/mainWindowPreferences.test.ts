import { describe, expect, it } from "vitest";

import { createMainWindowWebPreferences } from "./mainWindowPreferences.ts";

describe("createMainWindowWebPreferences", () => {
  it("enables preview webviews without weakening the app renderer sandbox", () => {
    expect(createMainWindowWebPreferences("/tmp/preload.cjs")).toMatchObject({
      preload: "/tmp/preload.cjs",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { getProviderVersionAdvisoryPresentation } from "./providerStatus";

describe("getProviderVersionAdvisoryPresentation", () => {
  it("presents a verified native update action without claiming a newer version exists", () => {
    expect(
      getProviderVersionAdvisoryPresentation({
        status: "unknown",
        currentVersion: "1.0.0",
        latestVersion: null,
        updateCommand: "codex update",
        canUpdate: true,
        checkedAt: "2026-08-27T21:00:00.000Z",
        message: null,
      }),
    ).toEqual({
      title: "Check for updates",
      detail: "Run the verified installer update, then T3 Code will check the version again.",
      updateCommand: "codex update",
      emphasis: "muted",
      icon: "refresh",
    });
  });

  it("keeps known updates on the semantic update treatment", () => {
    expect(
      getProviderVersionAdvisoryPresentation({
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        updateCommand: "npm install -g @openai/codex@latest",
        canUpdate: true,
        checkedAt: "2026-08-27T21:00:00.000Z",
        message: "Update available.",
      }),
    ).toMatchObject({
      title: "Update available",
      emphasis: "normal",
      icon: "update",
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  getProviderCompatibilityAdvisoryPresentation,
  getProviderCompatibilityUpdateCommand,
} from "./providerStatus";

describe("getProviderCompatibilityAdvisoryPresentation", () => {
  it("hides supported compatibility advisories", () => {
    expect(
      getProviderCompatibilityAdvisoryPresentation({
        status: "supported",
        severity: "info",
        currentVersion: "0.129.0",
        message: null,
        recommendedRange: ">=0.129.0",
        ranges: [],
      }),
    ).toBeNull();
  });

  it("presents broken compatibility advisories strongly", () => {
    expect(
      getProviderCompatibilityAdvisoryPresentation({
        status: "broken",
        severity: "error",
        currentVersion: "0.128.0",
        message: "Known incompatible.",
        recommendedRange: ">=0.129.0",
        ranges: [],
      }),
    ).toEqual({
      title: "Incompatible provider version",
      detail: "Known incompatible.",
      updateCommand: null,
      canUpdate: false,
      emphasis: "strong",
    });
  });

  it("derives targeted compatibility update commands from package install commands", () => {
    expect(
      getProviderCompatibilityUpdateCommand({
        compatibilityAdvisory: {
          status: "broken",
          severity: "error",
          currentVersion: "0.128.0",
          message: "Known incompatible.",
          recommendedRange: ">=0.129.0",
          recommendedVersion: "0.129.0",
          ranges: [],
        },
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "0.128.0",
          latestVersion: "0.130.0",
          checkedAt: "2026-05-13T00:00:00.000Z",
          message: "Update available.",
          updateCommand: "vp i -g @openai/codex",
          canUpdate: true,
        },
      }),
    ).toBe("vp i -g @openai/codex@0.129.0");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { formatProviderUpdateRequiredNotice } from "./providerUpdateRequiredModels.ts";

describe("formatProviderUpdateRequiredNotice", () => {
  it("does not ask for an update the install's own channel cannot deliver", () => {
    const homebrewClaude = {
      driver: "claudeAgent",
      updateRequiredModels: [
        { slug: "claude-fable-5-2", name: "Claude Fable 5.2", minVersion: "2.1.321" },
      ],
      versionAdvisory: {
        status: "current",
        currentVersion: "2.1.311",
        latestVersion: "2.1.311",
        updateCommand: "brew upgrade --cask claude-code",
        canUpdate: true,
        checkedAt: null,
        message: null,
      },
    } as const;

    const notice = formatProviderUpdateRequiredNotice(homebrewClaude);

    expect(notice).not.toBeNull();
    expect(notice).not.toMatch(/^Update Claude Code to v2\.1\.321/);
    expect(notice).toContain("2.1.311");
  });
});

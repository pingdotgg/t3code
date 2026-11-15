import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatProviderUpdateRequiredNotice } from "./providerUpdateRequiredModels.ts";

describe("formatProviderUpdateRequiredNotice", () => {
  it("does not ask for an update the install's own channel cannot deliver", () => {
    const homebrewClaude = {
      driver: ProviderDriverKind.make("claudeAgent"),
      updateRequiredModels: [
        { slug: "claude-fable-5-2", name: "Claude Fable 5.2", minVersion: "2.1.321" },
      ],
      versionAdvisory: {
        status: "current" as const,
        currentVersion: "2.1.311",
        latestVersion: "2.1.311",
        updateCommand: "brew upgrade --cask claude-code",
        canUpdate: true,
        checkedAt: null,
        message: null,
      },
    };

    const notice = formatProviderUpdateRequiredNotice(homebrewClaude);

    expect(notice).not.toBeNull();
    expect(notice).not.toMatch(/^Update Claude Code to v2\.1\.321/);
    expect(notice).toContain("2.1.311");
    expect(
      formatProviderUpdateRequiredNotice({
        ...homebrewClaude,
        versionAdvisory: { ...homebrewClaude.versionAdvisory, latestVersion: "2.1.330" },
      }),
    ).toBe("Update Claude Code to v2.1.321 or newer to use Claude Fable 5.2.");
  });
});

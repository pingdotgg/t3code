import { describe, expect, it } from "vite-plus/test";
import { formatProviderUpdateRequiredNotice } from "./providerUpdateRequiredModels.ts";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";

function provider(
  overrides: Partial<
    Pick<ServerProvider, "driver" | "updateRequiredModels" | "versionAdvisory">
  > = {},
): Pick<ServerProvider, "driver" | "updateRequiredModels" | "versionAdvisory"> {
  return {
    driver: ProviderDriverKind.make("claudeAgent"),
    updateRequiredModels: [
      { slug: "claude-fable-5-2", name: "Claude Fable 5.2", minVersion: "2.1.321" },
    ],
    ...overrides,
  };
}

describe("formatProviderUpdateRequiredNotice", () => {
  it("asks for an update when the install source can reach the model's version", () => {
    expect(
      formatProviderUpdateRequiredNotice(
        provider({
          versionAdvisory: {
            status: "behind_latest",
            currentVersion: "2.1.311",
            latestVersion: "2.1.330",
            updateCommand: "brew upgrade --cask claude-code",
            canUpdate: true,
            checkedAt: null,
            message: null,
          },
        }),
      ),
    ).toBe("Update Claude Code to v2.1.321 or newer to use Claude Fable 5.2.");
  });

  it("says so when the install source's latest is below the model's minimum", () => {
    expect(
      formatProviderUpdateRequiredNotice(
        provider({
          versionAdvisory: {
            status: "current",
            currentVersion: "2.1.311",
            latestVersion: "2.1.311",
            updateCommand: "brew upgrade --cask claude-code",
            canUpdate: true,
            checkedAt: null,
            message: null,
          },
        }),
      ),
    ).toBe(
      "Update Claude Code to v2.1.321 or newer to use Claude Fable 5.2. Your install source offers at most v2.1.311, so that update won't unlock it. For Homebrew, install the claude-code@latest cask (v2.1.321 or newer).",
    );
  });

  it("skips the cask hint when the update is not a Homebrew cask upgrade", () => {
    expect(
      formatProviderUpdateRequiredNotice(
        provider({
          versionAdvisory: {
            status: "current",
            currentVersion: "2.1.311",
            latestVersion: "2.1.311",
            updateCommand: null,
            canUpdate: false,
            checkedAt: null,
            message: null,
          },
        }),
      ),
    ).toBe(
      "Update Claude Code to v2.1.321 or newer to use Claude Fable 5.2. Your install source offers at most v2.1.311, so that update won't unlock it.",
    );
  });

  it("keeps the plain notice when the channel's latest is unknown", () => {
    const base = provider();
    expect(
      formatProviderUpdateRequiredNotice({
        driver: base.driver,
        updateRequiredModels: base.updateRequiredModels!,
      }),
    ).toBe("Update Claude Code to v2.1.321 or newer to use Claude Fable 5.2.");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { composerAddonBlockingIssue, type ComposerAddonContribution } from "./composer";

function contribution(addonId: string, blockingIssue: string | null): ComposerAddonContribution {
  return { addonId, blockingIssue, control: null };
}

describe("composer addon contributions", () => {
  it("returns the first blocking issue in registration order", () => {
    expect(
      composerAddonBlockingIssue([
        contribution("ready", null),
        contribution("blocked", "Complete addon setup"),
        contribution("also-blocked", "Another issue"),
      ]),
    ).toBe("Complete addon setup");
  });

  it("does not block the composer when every addon is ready", () => {
    expect(composerAddonBlockingIssue([contribution("ready", null)])).toBeNull();
  });
});

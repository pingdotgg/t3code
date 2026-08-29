import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSource } from "@t3tools/contracts";

import {
  canCloseWizard,
  initialWizardStep,
  initialTargetSelection,
  isRetryableReason,
  formatSkippedDomains,
  outcomeToStep,
  refreshedSourceProfileDirectory,
  refreshedSourceStep,
  resolveWizardTarget,
} from "./browserImportWizard.logic";

describe("wizard target selection", () => {
  it("treats an existing profile whose id is new as an existing target", () => {
    const profiles = [{ id: "new", name: "Existing new" }];
    const selection = initialTargetSelection(false, profiles);

    expect(selection).toEqual({ kind: "existing", profileId: "new" });
    expect(resolveWizardTarget(selection, "generated", profiles)).toEqual({
      kind: "existing",
      profileId: "new",
      name: "Existing new",
    });
  });
});

const source = (over: Partial<BrowserImportSource> = {}): BrowserImportSource => ({
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "You" }],
  ...over,
});

describe("initialWizardStep", () => {
  it("opens on the quit screen when the browser is running", () => {
    expect(initialWizardStep(source({ unavailable: "browserRunning" }))).toEqual({ step: "quit" });
  });

  it("opens on configure when the source is ready", () => {
    expect(initialWizardStep(source())).toEqual({ step: "configure" });
  });

  it("blocks on a reason nothing local can fix", () => {
    expect(initialWizardStep(source({ unavailable: "unsupportedPlatform" }))).toEqual({
      step: "blocked",
      reason: "unsupportedPlatform",
    });
  });

  it("blocks a ready source that reports no importable profiles", () => {
    expect(initialWizardStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });

  it("handles source availability before checking its profiles", () => {
    expect(
      initialWizardStep(source({ profiles: [], unavailable: "needsKeychainApproval" })),
    ).toEqual({ step: "blocked", reason: "needsKeychainApproval" });
  });
});

describe("canCloseWizard", () => {
  it("keeps the wizard open while an import writes its target profile", () => {
    expect(canCloseWizard({ step: "importing" })).toBe(false);
    expect(canCloseWizard({ step: "configure" })).toBe(true);
    expect(canCloseWizard({ step: "blocked", reason: "readFailed" })).toBe(true);
  });
});

describe("outcomeToStep", () => {
  it("lands on done after a successful import", () => {
    expect(
      outcomeToStep({
        kind: "imported",
        imported: 12,
        skipped: 3,
        skippedDomains: ["example.com"],
        targetName: "Work",
      }),
    ).toEqual({
      step: "done",
      imported: 12,
      skipped: 3,
      skippedDomains: ["example.com"],
      targetName: "Work",
    });
  });

  it("routes a reopened browser back to the quit screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "browserRunning" })).toEqual({ step: "quit" });
  });

  it("surfaces every other failure on the blocked screen", () => {
    expect(outcomeToStep({ kind: "blocked", reason: "readFailed" })).toEqual({
      step: "blocked",
      reason: "readFailed",
    });
  });
});

describe("refreshedSourceStep", () => {
  it("moves to configure once a quit browser frees its cookies", () => {
    expect(refreshedSourceStep(source())).toEqual({ step: "configure" });
  });

  it("stays on quit while the browser is still running", () => {
    expect(refreshedSourceStep(source({ unavailable: "browserRunning" }))).toEqual({
      step: "quit",
    });
  });

  it("blocks when the source vanished from the list", () => {
    expect(refreshedSourceStep(undefined)).toEqual({ step: "blocked", reason: "unknownSource" });
  });

  it("blocks when the refreshed source has no profiles", () => {
    expect(refreshedSourceStep(source({ profiles: [] }))).toEqual({
      step: "blocked",
      reason: "unknownSourceProfile",
    });
  });
});

describe("refreshedSourceProfileDirectory", () => {
  const refreshed = source({
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work" },
    ],
  });

  it("preserves a selected non-first profile after the browser quits", () => {
    expect(refreshedSourceProfileDirectory("Profile 2", refreshed)).toBe("Profile 2");
  });

  it("falls back only when the old profile vanished and clears an empty result", () => {
    expect(refreshedSourceProfileDirectory("Removed", refreshed)).toBe("Default");
    expect(refreshedSourceProfileDirectory("Removed", source({ profiles: [] }))).toBe("");
  });
});

describe("isRetryableReason", () => {
  it("offers a retry for failures a second attempt can clear", () => {
    expect(isRetryableReason("needsKeychainApproval")).toBe(true);
    expect(isRetryableReason("readFailed")).toBe(true);
  });

  it("does not offer a retry for a permanent failure", () => {
    expect(isRetryableReason("unsupportedPlatform")).toBe(false);
    expect(isRetryableReason("keychainItemMissing")).toBe(false);
    expect(isRetryableReason("unknownSourceProfile")).toBe(false);
  });
});

describe("formatSkippedDomains", () => {
  it("joins a short list naturally", () => {
    expect(formatSkippedDomains([])).toBe("");
    expect(formatSkippedDomains(["a.com"])).toBe("a.com");
    expect(formatSkippedDomains(["a.com", "b.com"])).toBe("a.com and b.com");
    expect(formatSkippedDomains(["a.com", "b.com", "c.com"])).toBe("a.com, b.com and c.com");
  });

  it("summarizes a long list", () => {
    expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"])).toBe(
      "a.com, b.com, c.com and 2 more",
    );
  });
});

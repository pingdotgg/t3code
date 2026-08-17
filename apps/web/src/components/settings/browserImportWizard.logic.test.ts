import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSource } from "@t3tools/contracts";

import {
  initialWizardStep,
  isRetryableReason,
  outcomeToStep,
  refreshedSourceStep,
} from "./browserImportWizard.logic";

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
});

describe("outcomeToStep", () => {
  it("lands on done after a successful import", () => {
    expect(
      outcomeToStep({ kind: "imported", imported: 12, skipped: 3, targetName: "Work" }),
    ).toEqual({ step: "done", imported: 12, skipped: 3, targetName: "Work" });
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
});

describe("isRetryableReason", () => {
  it("offers a retry for failures a second attempt can clear", () => {
    expect(isRetryableReason("needsKeychainApproval")).toBe(true);
    expect(isRetryableReason("readFailed")).toBe(true);
  });

  it("does not offer a retry for a permanent failure", () => {
    expect(isRetryableReason("unsupportedPlatform")).toBe(false);
    expect(isRetryableReason("keychainItemMissing")).toBe(false);
  });
});

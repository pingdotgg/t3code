import { describe, expect, it } from "vite-plus/test";

import {
  codexPermissionsLabel,
  codexRateLimitWindowLabel,
  codexRemainingPercent,
  describeCodexRuntimeMode,
  formatStatusTimestampWithTimeZone,
  isCodexSessionStatus,
} from "./StatusPage.logic";

describe("describeCodexRuntimeMode", () => {
  it("matches the read-only Codex policy", () => {
    expect(describeCodexRuntimeMode("approval-required")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      writableRoots: "none",
    });
  });

  it("matches the workspace-write Codex policies", () => {
    expect(describeCodexRuntimeMode("auto-accept-edits")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: "workspace",
    });
    expect(describeCodexRuntimeMode("auto")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      writableRoots: "workspace",
    });
  });

  it("matches the unrestricted Codex policy", () => {
    expect(describeCodexRuntimeMode("full-access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      writableRoots: "all paths",
    });
  });
});

describe("Codex status presentation", () => {
  it("uses the CLI permission labels", () => {
    expect(codexPermissionsLabel("approval-required")).toBe("Read Only");
    expect(codexPermissionsLabel("auto-accept-edits")).toBe("Workspace Write");
    expect(codexPermissionsLabel("full-access")).toBe("Full Access");
  });

  it("converts used rate-limit percentage into remaining percentage", () => {
    expect(codexRemainingPercent(24)).toBe(76);
    expect(codexRemainingPercent(-10)).toBe(100);
    expect(codexRemainingPercent(120)).toBe(0);
    expect(codexRateLimitWindowLabel(10_080)).toBe("Weekly limit");
  });

  it("does not count terminal Codex sessions as active", () => {
    expect(isCodexSessionStatus("starting")).toBe(true);
    expect(isCodexSessionStatus("running")).toBe(true);
    expect(isCodexSessionStatus("ready")).toBe(true);
    expect(isCodexSessionStatus("idle")).toBe(false);
    expect(isCodexSessionStatus("interrupted")).toBe(false);
    expect(isCodexSessionStatus("stopped")).toBe(false);
    expect(isCodexSessionStatus("error")).toBe(false);
  });

  it("adds the local timezone to status timestamps", () => {
    expect(formatStatusTimestampWithTimeZone("2026-08-12T19:22:00.000Z")).toMatch(/\(.+\)$/);
    expect(formatStatusTimestampWithTimeZone("not-a-date")).toBe("not-a-date");
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  codexPermissionsLabel,
  codexRateLimitWindowLabel,
  codexRemainingPercent,
  describeCodexRuntimeMode,
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
});

import { describe, expect, it } from "vite-plus/test";

import { describeCodexRuntimeMode } from "./StatusPage.logic";

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

import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexRuntimeModesAllowedByRequirements } from "./codexRuntimeModeRequirements.ts";

describe("codexRuntimeModesAllowedByRequirements", () => {
  it("leaves every mode available when nothing restricts Codex", () => {
    NodeAssert.equal(codexRuntimeModesAllowedByRequirements(null), undefined);
    NodeAssert.equal(codexRuntimeModesAllowedByRequirements({}), undefined);
  });

  it("drops full access when managed requirements forbid the danger-full-access sandbox", () => {
    NodeAssert.deepStrictEqual(
      codexRuntimeModesAllowedByRequirements({
        allowedSandboxModes: ["read-only", "workspace-write"],
      }),
      ["approval-required", "auto-accept-edits", "auto"],
    );
  });

  it("drops modes whose approval policy is forbidden", () => {
    NodeAssert.deepStrictEqual(
      codexRuntimeModesAllowedByRequirements({
        allowedApprovalPolicies: ["untrusted", "on-request"],
      }),
      ["approval-required", "auto-accept-edits", "auto"],
    );
    NodeAssert.deepStrictEqual(
      codexRuntimeModesAllowedByRequirements({
        allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
        allowedApprovalPolicies: ["untrusted"],
      }),
      ["approval-required"],
    );
  });
});

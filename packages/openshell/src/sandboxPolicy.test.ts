import { describe, expect, it } from "vite-plus/test";

import { sandboxPolicyForRuntimeMode } from "./sandboxPolicy.ts";

describe("sandboxPolicyForRuntimeMode", () => {
  it("maps approval-required to read-only with default-deny network", () => {
    expect(sandboxPolicyForRuntimeMode("approval-required")).toEqual({
      type: "readOnly",
      network: { mode: "default-deny", allowedDomains: [] },
    });
  });

  it("maps auto-accept-edits to workspace write plus the registry allowlist", () => {
    const policy = sandboxPolicyForRuntimeMode("auto-accept-edits");
    expect(policy.type).toBe("workspaceWrite");
    expect(policy.writableRoots).toEqual(["/sandbox"]);
    expect(policy.network.mode).toBe("allowlist");
    expect(policy.network.allowedDomains).toEqual(["registry.npmjs.org", "npm.pkg.github.com"]);
  });

  it("broadens the egress allowlist for auto", () => {
    const policy = sandboxPolicyForRuntimeMode("auto");
    expect(policy.network.allowedDomains).toContain("github.com");
    expect(policy.network.allowedDomains).toContain("registry.npmjs.org");
  });

  it("maps full-access to permissive", () => {
    expect(sandboxPolicyForRuntimeMode("full-access")).toEqual({
      type: "dangerFullAccess",
      network: { mode: "permissive", allowedDomains: [] },
    });
  });

  it("honors the workspace root and registry overrides", () => {
    const policy = sandboxPolicyForRuntimeMode("auto-accept-edits", {
      workspaceRoot: "/worktrees/x",
      registryDomains: ["registry.example.com"],
    });
    expect(policy.writableRoots).toEqual(["/worktrees/x"]);
    expect(policy.network.allowedDomains).toEqual(["registry.example.com"]);
  });

  it("stays assignable to the RuntimePolicy.sandboxPolicy seam", () => {
    const override: { sandboxPolicy?: unknown } = {
      sandboxPolicy: sandboxPolicyForRuntimeMode("approval-required"),
    };
    // Consumers switch on `type` (packages/provider-acp/src/server/clientPolicy.ts);
    // every mapped value must be one of the known kinds.
    const knownTypes = ["readOnly", "workspaceWrite", "dangerFullAccess"];
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"] as const) {
      const policy = sandboxPolicyForRuntimeMode(mode);
      expect(knownTypes).toContain(policy.type);
      override.sandboxPolicy = policy;
    }
    expect(override.sandboxPolicy).toBeDefined();
  });
});

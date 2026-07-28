import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { buildOpenCodePermissionRules, toOpenCodePermissionReply } from "./opencodeRuntime.ts";

describe("buildOpenCodePermissionRules", () => {
  it("returns allow-all for full-access mode", () => {
    const rules = buildOpenCodePermissionRules("full-access");
    NodeAssert.equal(rules.length, 1);
    NodeAssert.deepStrictEqual(rules[0], {
      permission: "*",
      pattern: "*",
      action: "allow",
    });
  });

  it("includes the permissions explicitly configured by the adapter", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = buildOpenCodePermissionRules(mode);
      const permissionNames = rules.map((r) => r.permission);

      NodeAssert.ok(permissionNames.includes("*"));
      NodeAssert.ok(permissionNames.includes("bash"));
      NodeAssert.ok(permissionNames.includes("read"));
      NodeAssert.ok(permissionNames.includes("edit"));
      NodeAssert.ok(permissionNames.includes("webfetch"));
      NodeAssert.ok(permissionNames.includes("websearch"));
      NodeAssert.ok(permissionNames.includes("codesearch"));
      NodeAssert.ok(permissionNames.includes("external_directory"));
      NodeAssert.ok(permissionNames.includes("doom_loop"));
    }
  });

  it("sets question permission to allow in non-full-access mode", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = buildOpenCodePermissionRules(mode);
      const questionRule = rules.find((r) => r.permission === "question");
      NodeAssert.ok(questionRule);
      NodeAssert.equal(questionRule.action, "allow");
    }
  });

  it("asks for actions in approval-required mode", () => {
    const rules = buildOpenCodePermissionRules("approval-required");
    for (const rule of rules) {
      if (rule.permission === "question") continue;
      NodeAssert.equal(rule.action, "ask", `expected ${rule.permission} to be ask`);
    }
  });

  it("auto-accepts edits in automatic modes while asking for commands", () => {
    for (const mode of ["auto-accept-edits", "auto"] as const) {
      const rules = buildOpenCodePermissionRules(mode);
      const editRule = rules.find((rule) => rule.permission === "edit");
      const bashRule = rules.find((rule) => rule.permission === "bash");

      NodeAssert.equal(editRule?.action, "allow");
      NodeAssert.equal(bashRule?.action, "ask");
    }
  });
});

describe("toOpenCodePermissionReply", () => {
  it('maps "accept" to "once"', () => {
    NodeAssert.equal(toOpenCodePermissionReply("accept"), "once");
  });

  it('maps "acceptForSession" to "always"', () => {
    NodeAssert.equal(toOpenCodePermissionReply("acceptForSession"), "always");
  });

  it('maps "decline" to "reject"', () => {
    NodeAssert.equal(toOpenCodePermissionReply("decline"), "reject");
  });

  it('maps "cancel" to "reject"', () => {
    NodeAssert.equal(toOpenCodePermissionReply("cancel"), "reject");
  });
});

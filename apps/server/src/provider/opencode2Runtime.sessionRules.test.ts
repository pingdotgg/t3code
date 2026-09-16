import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildOpenCode2SessionRules,
  OPENCODE2_MCP_NAMESPACE,
  openCode2McpServerName,
} from "./opencode2Runtime.ts";

const lastMatchingRule = (
  rules: ReturnType<typeof buildOpenCode2SessionRules>,
  action: string,
  resource = "*",
) => {
  const matching = rules.filter(
    (rule) =>
      // `*` matches zero or more characters in both fields.
      new RegExp(`^${rule.action.replaceAll("*", ".*")}$`).test(action) &&
      new RegExp(`^${rule.resource.replaceAll("*", ".*")}$`).test(resource),
  );
  return matching.length > 0 ? matching[matching.length - 1] : undefined;
};

const effectFor = (
  rules: ReturnType<typeof buildOpenCode2SessionRules>,
  action: string,
  resource = "*",
): "allow" | "deny" | "ask" | undefined => lastMatchingRule(rules, action, resource)?.effect;

/** Session rules for a mode, with an optional own registration name. */
const rulesFor = (
  runtimeMode: "full-access" | "approval-required" | "auto-accept-edits" | "auto",
  ownMcpServerName?: string,
) => buildOpenCode2SessionRules({ runtimeMode, ownMcpServerName });

describe("buildOpenCode2SessionRules", () => {
  it("grants full access freely while keeping cross-thread MCP isolation", () => {
    // Full access skips approvals for this thread's own work, but must not let
    // it act as another thread: the per-thread `t3-code-*` registrations carry
    // the target thread's credential and are visible to every session.
    const own = "t3-code-25e99ad6-4c39-49e3-8446-f6b58d7974ff";
    const rules = rulesFor("full-access", own);
    NodeAssert.deepEqual(effectFor(rules, "shell"), undefined);
    NodeAssert.deepEqual(effectFor(rules, "edit"), undefined);
    NodeAssert.deepEqual(
      effectFor(rules, "t3-code-00000000-0000-0000-0000-000000000000_list_thread_pull_requests"),
      "deny",
    );
    NodeAssert.deepEqual(effectFor(rules, `${own}_list_thread_pull_requests`), "allow");
    // Full access stays prompt-free: no catch-all ask, own tools auto-allowed.
    NodeAssert.equal(
      rules.some((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "ask"),
      false,
    );
  });

  it("isolates foreign registrations that nest a customized name", () => {
    // Registrations nest inside the reserved namespace, so one constant deny
    // covers them; a customized `mcpServerName` must not escape isolation.
    const own = openCode2McpServerName("corp", "25e99ad6-4c39-49e3-8446-f6b58d7974ff");
    for (const mode of ["full-access", "approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = rulesFor(mode, own);
      // Another thread on the same instance: denied even though visible.
      NodeAssert.deepEqual(
        effectFor(
          rules,
          `${openCode2McpServerName("corp", "00000000-0000-0000-0000-000000000000")}_list_thread_pull_requests`,
        ),
        "deny",
      );
      NodeAssert.deepEqual(
        effectFor(rules, `${own}_list_thread_pull_requests`),
        mode === "full-access" ? "allow" : "ask",
      );
    }
  });

  it("isolates a colocated instance that configured a different name", () => {
    // Regression: the deny was derived from this instance's own base, so with
    // separate instances (`corp` vs `work`) on one server neither denied the
    // other's registrations and their tools stayed callable cross-thread.
    const other = openCode2McpServerName("work", "tB");
    for (const mode of ["full-access", "approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = rulesFor(mode, openCode2McpServerName("corp", "tA"));
      NodeAssert.deepEqual(effectFor(rules, `${other}_list_thread_pull_requests`), "deny");
      NodeAssert.deepEqual(effectFor(rules, "t3-code-work-tB_list_thread_pull_requests"), "deny");
    }
  });

  it("keeps the reserved namespace regardless of the configured name", () => {
    // The sanitizer rewrites the configured name too (`corp.io` → `corp_io`),
    // and both the registration and the rules must agree on the result.
    const own = openCode2McpServerName("corp.io", "t1");
    NodeAssert.equal(own, "t3-code-corp_io-t1");
    NodeAssert.ok(own.startsWith(`${OPENCODE2_MCP_NAMESPACE}-`));

    const rules = rulesFor("full-access", own);
    NodeAssert.deepEqual(effectFor(rules, `${own}_list_thread_pull_requests`), "allow");
    NodeAssert.deepEqual(effectFor(rules, "t3-code-corp.io-t1_list_thread_pull_requests"), "deny");
  });

  it("keeps the cross-thread deny in every mode", () => {
    const own = "t3-code-25e99ad6-4c39-49e3-8446-f6b58d7974ff";
    for (const mode of ["full-access", "approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = rulesFor(mode, own);
      // Another thread's registration: denied even though visible.
      NodeAssert.deepEqual(
        effectFor(rules, "t3-code-00000000-0000-0000-0000-000000000000_list_thread_pull_requests"),
        "deny",
      );
      // This thread's own tools stay callable in every mode: auto-allowed
      // under full access, surfaced as an approval otherwise.
      const ownEffect = mode === "full-access" ? "allow" : "ask";
      NodeAssert.deepEqual(effectFor(rules, `${own}_list_thread_pull_requests`), ownEffect);
      // Bare prefix match without the tool suffix must not over-allow.
      NodeAssert.deepEqual(
        effectFor(rules, `t3-code-25e99ad6-4c39-49e3-8446-f6b58d7974ffX`),
        "deny",
      );
    }
  });

  it("asks for everything in supervised mode", () => {
    const rules = rulesFor("approval-required");
    NodeAssert.deepEqual(effectFor(rules, "shell"), "ask");
    NodeAssert.deepEqual(effectFor(rules, "edit"), "ask");
    NodeAssert.deepEqual(effectFor(rules, "webfetch"), "ask");
    NodeAssert.deepEqual(effectFor(rules, "mcp_tool", "*"), "ask");
  });

  it("denies foreign t3-code tools but keeps the thread's own callable", () => {
    // OpenCode checks MCP tool calls as `<sanitized-server>_<tool>`.
    const own = "t3-code-25e99ad6-4c39-49e3-8446-f6b58d7974ff";
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = rulesFor(mode, own);
      // Another thread's registration: denied even though visible.
      NodeAssert.deepEqual(
        effectFor(rules, "t3-code-00000000-0000-0000-0000-000000000000_list_thread_pull_requests"),
        "deny",
      );
      // This thread's own tools stay callable (ask → surfaced as approval).
      NodeAssert.deepEqual(effectFor(rules, `${own}_list_thread_pull_requests`), "ask");
      NodeAssert.deepEqual(effectFor(rules, `${own}_preview_open`), "ask");
      // Bare prefix match without the tool suffix must not over-allow.
      NodeAssert.deepEqual(
        effectFor(rules, `t3-code-25e99ad6-4c39-49e3-8446-f6b58d7974ffX`),
        "deny",
      );
    }
  });

  it("falls back to denying all t3-code tools when no own server name is given", () => {
    const rules = rulesFor("approval-required");
    NodeAssert.deepEqual(effectFor(rules, "t3-code-25e99ad6_list_thread_pull_requests"), "deny");
  });

  it("auto-allows edits only in auto-accept-edits mode", () => {
    const autoEdits = rulesFor("auto-accept-edits");
    NodeAssert.deepEqual(effectFor(autoEdits, "edit"), "allow");
    const supervised = rulesFor("approval-required");
    NodeAssert.deepEqual(effectFor(supervised, "edit"), "ask");
    // `auto` falls back to supervised for OpenCode (documented parity).
    const auto = rulesFor("auto");
    NodeAssert.deepEqual(effectFor(auto, "edit"), "ask");
  });

  it("keeps read-only discovery frictionless in every restricted mode", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = rulesFor(mode);
      NodeAssert.deepEqual(effectFor(rules, "read"), "allow");
      NodeAssert.deepEqual(effectFor(rules, "glob"), "allow");
      NodeAssert.deepEqual(effectFor(rules, "grep"), "allow");
      NodeAssert.deepEqual(effectFor(rules, "subagent"), "allow");
      NodeAssert.deepEqual(effectFor(rules, "question"), "allow");
    }
  });

  it("keeps .env reads behind an ask with an example-file exception", () => {
    const rules = rulesFor("approval-required");
    NodeAssert.deepEqual(effectFor(rules, "read", ".env"), "ask");
    NodeAssert.deepEqual(effectFor(rules, "read", "foo.env"), "ask");
    NodeAssert.deepEqual(effectFor(rules, "read", "foo.env.local"), "ask");
    NodeAssert.deepEqual(effectFor(rules, "read", "foo.env.example"), "allow");
    NodeAssert.deepEqual(effectFor(rules, "read", "src/main.ts"), "allow");
  });

  it("starts with a catch-all ask so unlisted actions cannot slip through", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const rules = rulesFor(mode);
      NodeAssert.deepEqual(rules[0], { action: "*", resource: "*", effect: "ask" });
      NodeAssert.deepEqual(effectFor(rules, "shell", "rm -rf /"), "ask");
      // Session rules are evaluated after agent rules with last-match-wins,
      // so the server asks even when agent config allows the action.
    }
  });

  it("covers every documented v2 core action (no v1 leftovers)", () => {
    const rules = rulesFor("approval-required");
    const actions = new Set(rules.map((rule) => rule.action));
    for (const action of ["read", "edit", "glob", "grep", "question", "subagent"]) {
      NodeAssert.deepEqual(actions.has(action), true);
    }
    // Everything else is covered by the `*` catch-all (verified above).
    // v1 `bash`/`task` do not exist in v2 and must not appear.
    NodeAssert.deepEqual(actions.has("bash"), false);
    NodeAssert.deepEqual(actions.has("task"), false);
  });
});

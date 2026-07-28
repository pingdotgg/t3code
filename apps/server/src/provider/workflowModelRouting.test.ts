import { describe, expect, it } from "vite-plus/test";

import {
  configuredWorkflowRouteCount,
  workflowModelRoutingInstructions,
  workflowRouteFor,
} from "./workflowModelRouting.ts";

const routing = {
  explore: { instanceId: "codex", model: "gpt-5.6-luna" },
  implement: { instanceId: "claudeAgent", model: "claude-fable-5" },
  verify: null,
} as const;

describe("workflow model routing", () => {
  it("describes configured routes and preserves parent inheritance", () => {
    const instructions = workflowModelRoutingInstructions(routing);
    expect(configuredWorkflowRouteCount(routing)).toBe(2);
    expect(instructions).toContain(
      "explore: codebase exploration and scoping -> codex/gpt-5.6-luna",
    );
    expect(instructions).toContain(
      "implement: implementation and edits -> claudeAgent/claude-fable-5",
    );
    expect(instructions).toContain("verify: verification, tests, and review -> inherit");
    expect(instructions).toContain("delegate_task");
  });

  it("resolves only an explicitly categorized route", () => {
    expect(workflowRouteFor(routing, "explore")).toEqual(routing.explore);
    expect(workflowRouteFor(routing, "verify")).toBeNull();
    expect(workflowRouteFor(routing, undefined)).toBeNull();
  });
});

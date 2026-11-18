import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { clearAutoCooldowns, isAutoCoolingDown, markAutoCooldown } from "./AutoCooldown.ts";
import { admitFailover, autoFailoverPlan, MAX_FAILOVERS_PER_HOUR } from "./AutoFailoverService.ts";

const now = Date.parse("2026-11-14T20:00:00.000Z");
const runId = RunId.make("run:thread:t1:ordinal:3");

function shell(overrides: Partial<Record<string, unknown>> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("t1"),
    providerInstanceId: ProviderInstanceId.make("claudeAuto"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAuto"),
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "medium" },
        { id: "auto", value: "medium" },
      ],
    },
    latestRunId: runId,
    lineage: {
      rootThreadId: ThreadId.make("t1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    creationSource: "user",
    status: "failed",
    lastErrorClass: "usage_limit",
    lastErrorCode: "api_error_429",
    usageLimitResetAt: null,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    ...overrides,
  } as unknown as OrchestrationV2ThreadShell;
}

const plan = (s: OrchestrationV2ThreadShell) =>
  autoFailoverPlan({ shell: s, runId, failedInstanceId: "claudeAuto", nowMs: now });

describe("autoFailoverPlan", () => {
  it("sends a limited Auto thread back through Auto at its level", () => {
    const result = plan(shell());
    expect(result?.command).toMatchObject({
      type: "message.dispatch",
      threadId: "t1",
      modelSelection: { instanceId: "claudeAuto", model: "auto-medium" },
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
    expect(result?.command.commandId).toBe(`server:auto-failover:t1:${runId}`);
    // No reported reset: a 30 minute bench.
    expect(result?.cooldownUntilMs).toBe(now + 30 * 60_000);
  });

  it("benches the instance until the reported reset", () => {
    const resetAt = "2026-11-14T23:00:00.000Z";
    expect(plan(shell({ usageLimitResetAt: resetAt }))?.cooldownUntilMs).toBe(Date.parse(resetAt));
  });

  it("fails over on no-capacity errors for a short bench", () => {
    const result = plan(shell({ lastErrorClass: "provider_error", lastErrorCode: "UNAVAILABLE" }));
    expect(result?.cooldownUntilMs).toBe(now + 5 * 60_000);
  });

  it("moves a hand-picked thread to Auto at the level its model implies", () => {
    const picked = (model: string) =>
      shell({ modelSelection: { instanceId: ProviderInstanceId.make("grok"), model } });
    expect(plan(picked("grok-4.7"))?.command.modelSelection).toEqual({
      instanceId: "grok",
      model: "auto-medium",
    });
    expect(plan(picked("gpt-6.1-sol"))?.command.modelSelection?.model).toBe("auto-high");
    expect(plan(picked("claude-haiku-5-5"))?.command.modelSelection?.model).toBe("auto-low");
    // A delegated thread keeps the model its parent chose.
    const delegated = {
      rootThreadId: ThreadId.make("t0"),
      parentThreadId: ThreadId.make("t0"),
      relationshipToParent: "subagent",
    };
    expect(plan(shell({ ...picked("grok-4.7"), lineage: delegated }))).toBeNull();
  });

  it("leaves other failures and stale runs alone", () => {
    expect(
      plan(shell({ lastErrorClass: "provider_error", lastErrorCode: "api_error_404" })),
    ).toBeNull();
    expect(plan(shell({ latestRunId: RunId.make("run:newer") }))).toBeNull();
    expect(plan(shell({ status: "idle" }))).toBeNull();
    expect(plan(shell({ settledOverride: "settled" }))).toBeNull();
  });
});

describe("admitFailover", () => {
  it("leaves a provider's own subagent alone, which cannot receive messages", () => {
    const lineage = {
      rootThreadId: ThreadId.make("t0"),
      parentThreadId: ThreadId.make("t0"),
      relationshipToParent: "subagent",
    };
    expect(plan(shell({ lineage, creationSource: "provider" }))).toBeNull();
    // A delegate_task child takes messages like any thread.
    expect(plan(shell({ lineage, creationSource: "agent" }))).not.toBeNull();
  });

  it("caps failovers per thread per hour", () => {
    const history: Array<number> = [];
    for (let i = 0; i < MAX_FAILOVERS_PER_HOUR; i++)
      expect(admitFailover(history, now + i)).toBe(true);
    expect(admitFailover(history, now + 10)).toBe(false);
    expect(admitFailover(history, now + 61 * 60_000)).toBe(true);
  });
});

describe("AutoCooldown", () => {
  it("benches an instance until the time passes", () => {
    clearAutoCooldowns();
    markAutoCooldown("claudeAuto", now + 1000);
    markAutoCooldown("claudeAuto", now + 500);
    expect(isAutoCoolingDown("claudeAuto", now + 999)).toBe(true);
    expect(isAutoCoolingDown("claudeAuto", now + 1000)).toBe(false);
    expect(isAutoCoolingDown("claudeAutoB", now)).toBe(false);
  });
});

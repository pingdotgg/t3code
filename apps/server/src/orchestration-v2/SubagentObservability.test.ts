import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";

import {
  accumulateCumulativeSubagentUsage,
  appendSubagentActivity,
  defaultSubagentRole,
  mergeCumulativeSubagentUsage,
  providerSubagentRole,
  subagentActivationFromSubagent,
} from "./SubagentObservability.ts";
import * as DateTime from "effect/DateTime";

describe("subagent observability", () => {
  it("derives the provider activation from the same V2 subagent lifecycle record", () => {
    const now = DateTime.makeUnsafe("2026-08-16T05:00:00.000Z");
    const subagent = {
      id: NodeId.make("subagent-1"),
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      parentNodeId: NodeId.make("root-1"),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("cursor"),
      providerInstanceId: ProviderInstanceId.make("cursor"),
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Review the implementation",
      title: "Reviewer",
      model: null,
      kind: "subagent",
      role: defaultSubagentRole(),
      status: "completed",
      result: "Done",
      usage: { totalTokens: 120 },
      currentActivationId: null,
      activationCount: 1,
      workflow: null,
      workflowMembership: null,
      recentActivity: [],
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    } satisfies OrchestrationV2Subagent;

    expect(
      subagentActivationFromSubagent({
        subagent,
        providerTurnId: ProviderTurnId.make("provider-turn-1"),
        ordinal: 1,
        status: "completed",
      }),
    ).toEqual({
      id: "subagent-1:activation:1",
      threadId: subagent.threadId,
      subagentId: subagent.id,
      runId: subagent.runId,
      providerTurnId: "provider-turn-1",
      ordinal: 1,
      status: "completed",
      usage: { totalTokens: 120 },
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
  });

  it("preserves role provenance instead of using titles as roles", () => {
    expect(providerSubagentRole(" reviewer ")).toEqual({
      name: "reviewer",
      source: "provider",
    });
    expect(providerSubagentRole(undefined)).toEqual(defaultSubagentRole());
  });

  it("accumulates activation deltas into stable lifetime usage", () => {
    const first = accumulateCumulativeSubagentUsage(null, null, {
      totalTokens: 100,
      inputTokens: 70,
      outputTokens: 30,
      toolUses: 2,
    });
    const firstAdvanced = accumulateCumulativeSubagentUsage(
      first,
      {
        totalTokens: 100,
        inputTokens: 70,
        outputTokens: 30,
        toolUses: 2,
      },
      {
        totalTokens: 140,
        inputTokens: 95,
        outputTokens: 45,
        toolUses: 3,
      },
    );
    const resumed = accumulateCumulativeSubagentUsage(firstAdvanced, null, {
      totalTokens: 80,
      inputTokens: 50,
      outputTokens: 30,
      toolUses: 1,
    });

    expect(firstAdvanced).toEqual({
      totalTokens: 140,
      inputTokens: 95,
      outputTokens: 45,
      toolUses: 3,
    });
    expect(resumed).toEqual({
      totalTokens: 220,
      inputTokens: 145,
      outputTokens: 75,
      toolUses: 4,
    });
  });

  it("bounds recent activity and deduplicates adjacent updates", () => {
    const now = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");
    const first = appendSubagentActivity([], "step 0", now);
    const deduplicated = appendSubagentActivity(first, "step 0", now);
    const activity = Array.from({ length: 7 }, (_, index) => `step ${index + 1}`).reduce(
      (current, summary) => appendSubagentActivity(current, summary, now),
      deduplicated,
    );

    expect(deduplicated).toBe(first);
    expect(activity).toHaveLength(6);
    expect(activity.map((entry) => entry.summary)).toEqual([
      "step 2",
      "step 3",
      "step 4",
      "step 5",
      "step 6",
      "step 7",
    ]);
    expect(appendSubagentActivity([], "   ", now)).toEqual([]);
  });

  it("merges cumulative provider counters without double-counting", () => {
    expect(
      mergeCumulativeSubagentUsage(
        { totalTokens: 100, outputTokens: 25 },
        { totalTokens: 140, outputTokens: 20 },
      ),
    ).toEqual({ totalTokens: 140, outputTokens: 25 });
  });

  it("is idempotent for duplicate and late cumulative snapshots", () => {
    const latest = {
      totalTokens: 140,
      inputTokens: 95,
      outputTokens: 45,
      toolUses: 3,
    };
    const duplicate = mergeCumulativeSubagentUsage(latest, latest);
    const late = mergeCumulativeSubagentUsage(duplicate, {
      totalTokens: 100,
      inputTokens: 70,
      outputTokens: 30,
      toolUses: 2,
    });

    expect(duplicate).toEqual(latest);
    expect(late).toEqual(latest);
    expect(accumulateCumulativeSubagentUsage(latest, latest, duplicate)).toEqual(latest);
  });

  it("preserves omitted activation counters when they reappear", () => {
    const firstActivation = { totalTokens: 100, inputTokens: 70 };
    const withoutInput = mergeCumulativeSubagentUsage(firstActivation, { totalTokens: 140 });
    const lifetimeWithoutInput = accumulateCumulativeSubagentUsage(
      firstActivation,
      firstActivation,
      {
        totalTokens: 140,
      },
    );
    const restoredInput = mergeCumulativeSubagentUsage(withoutInput, {
      totalTokens: 180,
      inputTokens: 100,
    });

    expect(withoutInput).toEqual({ totalTokens: 140, inputTokens: 70 });
    expect(
      accumulateCumulativeSubagentUsage(lifetimeWithoutInput, withoutInput, restoredInput),
    ).toEqual({ totalTokens: 180, inputTokens: 100 });
  });
});

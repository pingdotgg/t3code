import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2GetThreadInsightsResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "../environment/scoped.ts";
import { mergeThreadInsights, type ThreadInsightsAnswer } from "./threadInsights.ts";

const ref = (environment: string, thread: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environment),
  threadId: ThreadId.make(thread),
});
const row = (
  threadId: string,
  inputTokens: number,
): OrchestrationV2GetThreadInsightsResult["rows"][number] => ({
  threadId: ThreadId.make(threadId),
  parentThreadId: null,
  title: threadId,
  status: "completed",
  providerInstanceIds: [],
  steps: [{ id: "a", text: "Step", status: "completed" }],
  usage: {
    status: "complete",
    turns: 1,
    measuredTurns: 1,
    inputTokens,
    outputTokens: 10,
    costUsd: null,
    unpricedTurns: 1,
    hasOtherUsage: false,
  },
});
const answer = (
  target: ScopedThreadRef,
  overrides: Partial<OrchestrationV2GetThreadInsightsResult> = {},
): ThreadInsightsAnswer => ({
  target,
  data: { rows: [], remotes: [], unavailableThreadIds: [], truncated: false, ...overrides },
});

describe("mergeThreadInsights", () => {
  it("keeps missing remote usage partial, scopes duplicate thread IDs by environment, and discards unreachable old answers", () => {
    const root = ref("local", "root");
    const remote = ref("remote", "root");
    const stale = ref("stale", "old");
    const localAnswer = answer(root, {
      rows: [row("root", 100)],
      remotes: [{ ...remote, parentThreadId: root.threadId, title: "Remote", status: "completed" }],
    });
    const answers = new Map([
      [scopedThreadKey(root), localAnswer],
      [scopedThreadKey(stale), answer(stale, { rows: [row("old", 9000)] })],
    ]);
    const pending = mergeThreadInsights(root, answers);
    expect(pending.inputTokens).toBe(100);
    expect(pending.partial).toBe(true);
    expect(pending.pending).toEqual([
      { ...remote, parentThreadId: root.threadId, title: "Remote", status: "completed" },
    ]);
    answers.set(
      scopedThreadKey(remote),
      answer(remote, {
        rows: [row("root", 300)],
        remotes: [
          { ...root, parentThreadId: remote.threadId, title: "Cycle", status: "completed" },
        ],
      }),
    );
    const complete = mergeThreadInsights(root, answers);
    expect(complete.rows).toHaveLength(2);
    expect(complete.inputTokens).toBe(400);
    expect(complete.tasks).toEqual({ done: 2, total: 2, lists: 2 });
    expect(complete.partial).toBe(false);
    answers.set(scopedThreadKey(root), answer(root, { rows: [row("root", 100)] }));
    expect(mergeThreadInsights(root, answers).inputTokens).toBe(100);
  });

  it("preserves unreported counters and incomplete local coverage", () => {
    const root = ref("local", "root");
    const result = mergeThreadInsights(
      root,
      new Map([
        [
          scopedThreadKey(root),
          answer(root, {
            rows: [{ ...row("root", 100), steps: null }],
            truncated: true,
            unavailableThreadIds: [ThreadId.make("deleted")],
          }),
        ],
      ]),
    );
    expect(result.cachedInputTokens).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.tasks).toEqual({ done: 0, total: 0, lists: 0 });
    expect(result.partial).toBe(true);
    expect(result.unavailable).toBe(1);
  });
});

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { RateTable } from "./usagePricing.ts";
import { foldThreadRows, ThreadUsageAccumulator, type ThreadAttribution } from "./usageThreads.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    cwd: "/work/app",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: null,
    ...overrides,
  };
}

function accumulate(
  entries: readonly (readonly [UsageRecord, { sessionKey: string; agentId: string | null }])[],
) {
  const accumulator = new ThreadUsageAccumulator({
    timeZone: "UTC",
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    rates,
  });
  for (const [item, context] of entries) accumulator.add(item, context);
  return accumulator.finish();
}

const NO_ATTRIBUTION: ThreadAttribution = {
  sessionToThread: new Map(),
  worktreeToThread: new Map(),
};

describe("ThreadUsageAccumulator", () => {
  it("groups records by session and splits subagent slices out", () => {
    const main = { sessionKey: "claude:session-a", agentId: null };
    const agent = { sessionKey: "claude:session-a", agentId: "agent-1" };
    const groups = accumulate([
      [record(), main],
      [record(), agent],
      [record({ sessionId: "session-b" }), { sessionKey: "claude:session-b", agentId: null }],
    ]);

    expect(groups).toHaveLength(2);
    const sessionA = groups.find((group) => group.sessionKey === "claude:session-a");
    expect(sessionA?.totals.outputTokens).toBe(100);
    expect(sessionA?.agents.get("agent-1")?.totals.outputTokens).toBe(50);
  });

  it("dedupes globally across files with the summary's semantics", () => {
    const context = { sessionKey: "claude:session-a", agentId: null };
    const groups = accumulate([
      [record({ dedupeKey: "msg_1:" }), context],
      [record({ dedupeKey: "msg_1:" }), context],
    ]);

    expect(groups[0]?.totals.outputTokens).toBe(50);
  });

  it("records each day's estimated cost", () => {
    const context = { sessionKey: "claude:session-a", agentId: null };
    const groups = accumulate([[record(), context]]);
    const day = groups[0]?.daily.get("2026-08-07");

    expect(day).toBeCloseTo(100 * 1e-5 + 1000 * 1e-6 + 10 * 1.25e-5 + 50 * 5e-5, 12);
  });

  it("drops records outside the window", () => {
    const context = { sessionKey: "claude:session-a", agentId: null };
    const groups = accumulate([
      [record({ timestampMs: Date.parse("2026-07-01T00:00:00Z") }), context],
    ]);

    expect(groups).toHaveLength(0);
  });
});

describe("foldThreadRows", () => {
  const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");

  it("folds sessions into one row per thread via cursor and worktree matches", () => {
    const groups = accumulate([
      [record(), { sessionKey: "claude:session-a", agentId: null }],
      [
        record({ sessionId: "session-b", cwd: "/work/app/.wt/thread-1" }),
        { sessionKey: "claude:session-b", agentId: null },
      ],
      [record({ sessionId: "session-c" }), { sessionKey: "claude:session-c", agentId: null }],
    ]);
    const attribution: ThreadAttribution = {
      sessionToThread: new Map([["claude:session-a", { threadId, title: "Fix the flaky test" }]]),
      worktreeToThread: new Map([
        ["/work/app/.wt/thread-1", { threadId, title: "Fix the flaky test" }],
      ]),
    };

    const { rows, truncatedRows } = foldThreadRows(groups, attribution, { cap: 40 });

    expect(truncatedRows).toBe(0);
    expect(rows).toHaveLength(2);
    const threadRow = rows.find((row) => row.threadId === threadId);
    expect(threadRow?.title).toBe("Fix the flaky test");
    expect(threadRow?.sessions).toBe(2);
    const standalone = rows.find((row) => row.threadId === null);
    // Standalone rows leave the title to the caller's transcript read.
    expect(standalone?.title).toBeNull();
    expect(standalone?.key).toBe("session:claude:session-c");
  });

  it("caps rows by cost and counts the rest", () => {
    const groups = accumulate(
      Array.from({ length: 5 }, (_, index) => [
        record({ sessionId: `session-${index}` }),
        { sessionKey: `claude:session-${index}`, agentId: null },
      ]),
    );

    const { rows, truncatedRows } = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 3 });

    expect(rows).toHaveLength(3);
    expect(truncatedRows).toBe(2);
  });

  it("filters by project before capping", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject: (cwd) => (cwd === "/work/app" ? "App" : ""),
    });
    accumulator.add(record(), { sessionKey: "claude:session-a", agentId: null });
    accumulator.add(record({ sessionId: "session-b", cwd: "/elsewhere" }), {
      sessionKey: "claude:session-b",
      agentId: null,
    });
    const groups = accumulator.finish();

    const app = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 40, projectFilter: "App" });
    expect(app.rows.map((row) => row.key)).toEqual(["session:claude:session-a"]);

    const outside = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 40, projectFilter: null });
    expect(outside.rows.map((row) => row.key)).toEqual(["session:claude:session-b"]);
  });
});

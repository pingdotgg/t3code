import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
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

  it("scopes one T3 thread by provider and project", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject: (cwd) => (cwd.endsWith("one") ? "Project one" : "Project two"),
    });
    const entries = [
      [record({ sessionId: "claude-one", cwd: "/work/one" }), "claude:claude-one"],
      [record({ sessionId: "claude-two", cwd: "/work/two" }), "claude:claude-two"],
      [
        record({
          provider: "codex",
          model: "gpt-5.6-sol",
          sessionId: "codex-one",
          cwd: "/work/one",
        }),
        "codex:codex-one",
      ],
    ] as const;
    for (const [item, sessionKey] of entries) {
      accumulator.add(item, { sessionKey, agentId: null });
    }
    const attribution: ThreadAttribution = {
      sessionToThread: new Map(
        entries.map(([, sessionKey]) => [sessionKey, { threadId, title: "Shared thread" }]),
      ),
      worktreeToThread: new Map(),
    };

    const { rows } = foldThreadRows(accumulator.finish(), attribution, { cap: 40 });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.provider, row.project]).toSorted()).toEqual([
      ["claude", "Project one"],
      ["claude", "Project two"],
      ["codex", "Project one"],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(rows.every((row) => row.threadId === threadId && row.title === "Shared thread")).toBe(
      true,
    );

    const projectOne = foldThreadRows(accumulator.finish(), attribution, {
      cap: 40,
      projectFilter: "Project one",
    });
    expect(projectOne.rows.map((row) => [row.provider, row.project]).toSorted()).toEqual([
      ["claude", "Project one"],
      ["codex", "Project one"],
    ]);
  });

  it("groups rows past the cap without losing their usage", () => {
    const groups = accumulate(
      Array.from({ length: 5 }, (_, index) => [
        record({ sessionId: `session-${index}` }),
        { sessionKey: `claude:session-${index}`, agentId: null },
      ]),
    );

    const { rows, truncatedRows } = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 3 });

    expect(rows).toHaveLength(4);
    expect(truncatedRows).toBe(2);
    expect(rows.find((row) => row.key.startsWith("remainder:"))?.title).toBe("Other threads (2)");
    expect(rows.find((row) => row.key.startsWith("remainder:"))?.groupedRows).toBe(2);
    expect(rows.reduce((sum, row) => sum + row.totals.outputTokens, 0)).toBe(250);
  });

  it("reconciles every provider and project after lower-cost rows are grouped", () => {
    const resolveProject = (cwd: string) => (cwd.endsWith("one") ? "Project one" : "Project two");
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject,
    });
    const summary = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      resolution: "day",
      rates,
      resolveProject,
    });
    for (const [index, provider, project] of [
      [0, "claude", "one"],
      [1, "claude", "one"],
      [2, "claude", "two"],
      [3, "codex", "one"],
      [4, "codex", "two"],
    ] as const) {
      const item = record({
        provider,
        model: provider === "claude" ? "claude-fable-5" : "gpt-5.6-sol",
        sessionId: `session-${index}`,
        cwd: `/work/${project}`,
      });
      accumulator.add(item, { sessionKey: `${provider}:session-${index}`, agentId: null });
      summary.add(item);
    }
    const groups = accumulator.finish();

    const { rows } = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 1 });
    const expected = new Map<string, number>();
    for (const bucket of summary.finish().buckets) {
      const key = `${bucket.provider}:${bucket.project ?? ""}`;
      expected.set(key, (expected.get(key) ?? 0) + bucket.totals.outputTokens);
    }
    const actual = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.provider}:${row.project ?? ""}`;
      actual.set(key, (actual.get(key) ?? 0) + row.totals.outputTokens);
    }

    expect(actual).toEqual(expected);
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

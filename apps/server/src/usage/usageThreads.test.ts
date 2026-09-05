import { ProjectId, ThreadId } from "@t3tools/contracts";
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
      cacheCreation1hCostPerToken: 2e-5,
    },
  ],
]);

const PROJECT_ONE = { projectId: ProjectId.make("project-one"), title: "Project one" };
const PROJECT_TWO = { projectId: ProjectId.make("project-two"), title: "Project two" };

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

  it("uses the final complete snapshot across files", () => {
    const context = { sessionKey: "claude:session-a", agentId: null };
    const groups = accumulate([
      [
        record({ dedupeKey: "msg_partial:", totals: { ...record().totals, outputTokens: 1 } }),
        context,
      ],
      [
        record({ dedupeKey: "msg_partial:", totals: { ...record().totals, outputTokens: 310 } }),
        context,
      ],
    ]);

    expect(groups[0]?.totals.outputTokens).toBe(310);
  });

  it("applies the window to the final complete snapshot", () => {
    const context = { sessionKey: "claude:session-a", agentId: null };
    const groups = accumulate([
      [record({ dedupeKey: "msg_partial:" }), context],
      [
        record({
          dedupeKey: "msg_partial:",
          timestampMs: Date.parse("2026-09-01T00:00:00Z"),
        }),
        context,
      ],
    ]);

    expect(groups).toEqual([]);
  });

  it("splits each day's model-priced cost into cache components", () => {
    const context = { sessionKey: "claude:session-a", agentId: null };
    const groups = accumulate([[record(), context]]);
    const day = groups[0]?.daily.get("2026-08-07");

    expect(day?.cacheWriteUsd).toBeCloseTo(10 * 1.25e-5, 12);
    expect(day?.cacheReadUsd).toBeCloseTo(1000 * 1e-6, 12);
    expect(day?.freshUsd).toBeCloseTo(100 * 1e-5 + 50 * 5e-5, 12);
  });

  it("does not invent component costs for provider-reported totals", () => {
    const context = { sessionKey: "claude:session-a", agentId: "agent-1" };
    const groups = accumulate([[record({ reportedCostUsd: 1.25 }), context]]);
    const rows = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 40 });

    expect(rows.rows[0]?.costUsd).toBe(1.25);
    expect(rows.rows[0]?.cacheWriteUsd).toBeNull();
    expect(rows.rows[0]?.agents[0]?.cacheWriteUsd).toBeNull();
    expect(rows.rows[0]?.daily).toEqual([]);
  });

  it("uses custom prices for thread totals and component costs", () => {
    const customRates: RateTable = new Map([
      [
        "claude-fable-5",
        {
          inputCostPerToken: 2e-5,
          outputCostPerToken: 1e-4,
          cacheReadCostPerToken: 2e-6,
          cacheCreationCostPerToken: 2.5e-5,
        },
      ],
    ]);
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      priceOverrides: customRates,
    });
    accumulator.add(record({ reportedCostUsd: 1.25 }), {
      sessionKey: "claude:session-a",
      agentId: null,
    });

    const group = accumulator.finish()[0];
    const day = group?.daily.get("2026-08-07");
    expect(group?.costUsd).toBeCloseTo(100 * 2e-5 + 1000 * 2e-6 + 10 * 2.5e-5 + 50 * 1e-4, 12);
    expect(day?.cacheWriteUsd).toBeCloseTo(10 * 2.5e-5, 12);
    expect(day?.cacheReadUsd).toBeCloseTo(1000 * 2e-6, 12);
    expect(day?.freshUsd).toBeCloseTo(100 * 2e-5 + 50 * 1e-4, 12);
  });

  it("drops records outside the window", () => {
    const context = { sessionKey: "claude:session-a", agentId: null };
    const groups = accumulate([
      [record({ timestampMs: Date.parse("2026-07-01T00:00:00Z") }), context],
    ]);

    expect(groups).toHaveLength(0);
  });

  it("drops timestamps outside the JavaScript date range", () => {
    const context = { sessionKey: "grok:session-a", agentId: null };
    expect(() => accumulate([[record({ timestampMs: 1e20 }), context]])).not.toThrow();
    expect(accumulate([[record({ timestampMs: 1e20 }), context]])).toEqual([]);
  });

  it("applies exact time bounds inside a shared calendar day", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-07",
      untilDay: "2026-08-07",
      sinceTimeMs: Date.parse("2026-08-07T04:00:00Z"),
      untilTimeMs: Date.parse("2026-08-07T05:00:00Z"),
      rates,
    });
    const context = { sessionKey: "claude:session-a", agentId: null };
    accumulator.add(record({ timestampMs: Date.parse("2026-08-07T03:59:59Z") }), context);
    accumulator.add(record({ timestampMs: Date.parse("2026-08-07T04:30:00Z") }), context);
    accumulator.add(record({ timestampMs: Date.parse("2026-08-07T05:00:00Z") }), context);

    expect(accumulator.finish()[0]?.totals.outputTokens).toBe(50);
  });

  it("uses exact bounds without applying a second calendar-day filter", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-07",
      untilDay: "2026-08-07",
      sinceTimeMs: Date.parse("2026-08-08T04:00:00Z"),
      untilTimeMs: Date.parse("2026-08-08T05:00:00Z"),
      rates,
    });

    accumulator.add(record({ timestampMs: Date.parse("2026-08-08T04:30:00Z") }), {
      sessionKey: "claude:exact-window",
      agentId: null,
    });

    expect(accumulator.finish()[0]?.totals.outputTokens).toBe(50);
  });

  it("keeps separate cwd slices when one session crosses projects", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject: (cwd) => (cwd.endsWith("one") ? PROJECT_ONE : PROJECT_TWO),
    });
    const context = { sessionKey: "claude:session-a", agentId: null };
    accumulator.add(record({ cwd: "/work/one" }), context);
    accumulator.add(record({ cwd: "/work/two" }), context);

    expect(
      accumulator
        .finish()
        .map((group) => group.projectKey)
        .toSorted(),
    ).toEqual(["id:project-one", "id:project-two"]);
  });
});

describe("foldThreadRows", () => {
  const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");

  it("keeps only the requested thread before applying the row cap", () => {
    const targetThreadId = ThreadId.make("thread-target");
    const groups = accumulate([
      [
        record({ sessionId: "expensive", totals: { ...record().totals, outputTokens: 1_000 } }),
        { sessionKey: "claude:expensive", agentId: null },
      ],
      [record({ sessionId: "target" }), { sessionKey: "claude:target", agentId: null }],
      [
        record({ sessionId: "other", totals: { ...record().totals, outputTokens: 500 } }),
        { sessionKey: "claude:other", agentId: null },
      ],
    ]);
    const attribution: ThreadAttribution = {
      sessionToThread: new Map([
        ["claude:expensive", { threadId: ThreadId.make("thread-expensive"), title: "Expensive" }],
        ["claude:target", { threadId: targetThreadId, title: "Target" }],
        ["claude:other", { threadId: ThreadId.make("thread-other"), title: "Other" }],
      ]),
      worktreeToThread: new Map(),
    };

    const result = foldThreadRows(groups, attribution, { cap: 1, threadFilter: targetThreadId });

    expect(result.truncatedRows).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.threadId).toBe(targetThreadId);
  });

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
    expect(standalone?.key).toContain("claude:session-c");
  });

  it("uses the deepest worktree ancestor for sessions run in subdirectories", () => {
    const nestedThreadId = ThreadId.make("22222222-2222-4222-8222-222222222222");
    const groups = accumulate([
      [
        record({ sessionId: "nested", cwd: "/work/app/.wt/thread-1/packages/web" }),
        { sessionKey: "claude:nested", agentId: null },
      ],
    ]);
    const attribution: ThreadAttribution = {
      sessionToThread: new Map(),
      worktreeToThread: new Map([
        ["/work/app", { threadId, title: "Shared root" }],
        ["/work/app/.wt/thread-1", { threadId: nestedThreadId, title: "Nested worktree" }],
      ]),
    };

    const { rows } = foldThreadRows(groups, attribution, { cap: 40 });

    expect(rows[0]?.threadId).toBe(nestedThreadId);
    expect(rows[0]?.title).toBe("Nested worktree");
  });

  it("matches worktrees across slash styles and normalized segments", () => {
    const groups = accumulate([
      [
        record({ sessionId: "mixed", cwd: "\\work\\app\\.wt\\thread-1\\packages\\web" }),
        { sessionKey: "claude:mixed", agentId: null },
      ],
    ]);
    const attribution: ThreadAttribution = {
      sessionToThread: new Map(),
      worktreeToThread: new Map([
        ["/work/app/other/../.wt/thread-1/", { threadId, title: "Normalized worktree" }],
      ]),
    };

    const { rows } = foldThreadRows(groups, attribution, { cap: 40 });

    expect(rows[0]?.threadId).toBe(threadId);
    expect(rows[0]?.title).toBe("Normalized worktree");
  });
  it("matches Windows worktrees without changing POSIX case sensitivity", () => {
    const groups = accumulate([
      [
        record({ sessionId: "windows", cwd: "c:\\work\\app\\.wt\\thread-1\\src" }),
        { sessionKey: "claude:windows", agentId: null },
      ],
      [
        record({ sessionId: "posix", cwd: "/work/app/.wt/thread-1/src" }),
        { sessionKey: "claude:posix", agentId: null },
      ],
    ]);
    const attribution: ThreadAttribution = {
      sessionToThread: new Map(),
      worktreeToThread: new Map([
        ["C:\\Work\\App\\.wt\\thread-1", { threadId, title: "Windows worktree" }],
        ["/Work/App/.wt/thread-1", { threadId, title: "Different POSIX worktree" }],
      ]),
    };

    const { rows } = foldThreadRows(groups, attribution, { cap: 40 });

    const threadRow = rows.find((row) => row.threadId === threadId);
    expect(threadRow?.sessions).toBe(1);
    expect(rows.some((row) => row.threadId === null && row.sessions === 1)).toBe(true);
  });
  it("scopes one T3 thread by provider and project", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject: (cwd) => (cwd.endsWith("one") ? PROJECT_ONE : PROJECT_TWO),
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
      projectFilter: "id:project-one",
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

    expect(rows).toHaveLength(3);
    expect(truncatedRows).toBe(3);
    expect(rows.find((row) => row.key.startsWith("remainder:"))?.title).toBe("Other threads (3)");
    expect(rows.find((row) => row.key.startsWith("remainder:"))?.groupedRows).toBe(3);
    expect(rows.reduce((sum, row) => sum + row.totals.outputTokens, 0)).toBe(250);
  });

  it("keeps subagent slices when lower-cost rows fold into a remainder", () => {
    const groups = accumulate([
      [
        record({ sessionId: "expensive", totals: { ...record().totals, outputTokens: 100 } }),
        { sessionKey: "claude:expensive", agentId: null },
      ],
      [
        record({ sessionId: "cheaper" }),
        { sessionKey: "claude:cheaper", agentId: "agent-cheaper" },
      ],
    ]);

    const { rows } = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 1 });
    const remainder = rows.find((row) => row.key.startsWith("remainder:"));
    expect(remainder?.agents.map((agent) => agent.agentId)).toEqual(["agent-cheaper"]);
  });

  it("bounds and reconciles subagents folded into a remainder", () => {
    const groups = accumulate([
      [
        record({ sessionId: "expensive", totals: { ...record().totals, outputTokens: 100 } }),
        { sessionKey: "claude:expensive", agentId: null },
      ],
      ...Array.from(
        { length: 5 },
        (_, index) =>
          [
            record({ sessionId: `cheaper-${index}` }),
            { sessionKey: `claude:cheaper-${index}`, agentId: `agent-${index}` },
          ] as const,
      ),
    ]);

    const { rows } = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 2 });
    const remainder = rows.find((row) => row.key.startsWith("remainder:"));

    expect(remainder?.agents).toHaveLength(2);
    expect(remainder?.agents.some((agent) => agent.agentId === "Other subagents (4)")).toBe(true);
    expect(remainder?.agents.reduce((sum, agent) => sum + agent.totals.outputTokens, 0)).toBe(250);
  });

  it("collapses overflow project scopes without exceeding the response cap", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject: (cwd) => ({
        projectId: ProjectId.make(`project-${cwd.slice(-1)}`),
        title: `Project ${cwd.slice(-1)}`,
      }),
    });
    for (let index = 0; index < 6; index += 1) {
      accumulator.add(record({ sessionId: `session-${index}`, cwd: `/work/${index}` }), {
        sessionKey: `claude:session-${index}`,
        agentId: null,
      });
    }

    const { rows } = foldThreadRows(accumulator.finish(), NO_ATTRIBUTION, { cap: 3 });

    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.reduce((sum, row) => sum + row.totals.outputTokens, 0)).toBe(300);
  });

  it("reconciles every provider and project after lower-cost rows are grouped", () => {
    const resolveProject = (cwd: string) => (cwd.endsWith("one") ? PROJECT_ONE : PROJECT_TWO);
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

    const { rows } = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 4 });
    expect(rows.length).toBeLessThanOrEqual(4);
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
      resolveProject: (cwd) => (cwd === "/work/app" ? PROJECT_ONE : null),
    });
    accumulator.add(record(), { sessionKey: "claude:session-a", agentId: null });
    accumulator.add(record({ sessionId: "session-b", cwd: "/elsewhere" }), {
      sessionKey: "claude:session-b",
      agentId: null,
    });
    const groups = accumulator.finish();

    const app = foldThreadRows(groups, NO_ATTRIBUTION, {
      cap: 40,
      projectFilter: "id:project-one",
    });
    expect(app.rows.map((row) => row.key)).toHaveLength(1);
    expect(app.rows[0]?.key).toContain("claude:session-a");

    const outside = foldThreadRows(groups, NO_ATTRIBUTION, { cap: 40, projectFilter: null });
    expect(outside.rows.map((row) => row.key)).toHaveLength(1);
    expect(outside.rows[0]?.key).toContain("claude:session-b");
  });

  it("excludes unknown project attribution from the outside-project filter", () => {
    const accumulator = new ThreadUsageAccumulator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
      resolveProject: () => null,
    });
    accumulator.add(record({ sessionId: "outside", cwd: "/elsewhere" }), {
      sessionKey: "claude:outside",
      agentId: null,
    });
    accumulator.add(record({ provider: "grok", sessionId: "unknown", cwd: "" }), {
      sessionKey: "grok:unknown",
      agentId: null,
    });

    const outside = foldThreadRows(accumulator.finish(), NO_ATTRIBUTION, {
      cap: 40,
      projectFilter: null,
    });

    expect(outside.rows).toHaveLength(1);
    expect(outside.rows[0]?.key).toContain("claude:outside");
  });
});

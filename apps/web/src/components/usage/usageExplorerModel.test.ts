import { ProjectId, ThreadId, UsageDay, type UsageBucket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBreakdownRows } from "./usageBreakdownRows";
import {
  binKey,
  buildExplorerData,
  buildSeries,
  chartColumns,
  familyTotals,
  foldFacts,
  keyFor,
  OTHER_SERIES,
  OUTSIDE_PROJECTS,
  rankEntries,
  SERIES_PALETTE,
  toCsv,
  UNKNOWN_PROJECT,
  emptyTotals,
  type UsageExplorerSource,
} from "./usageExplorerModel";

const bucket = (overrides: Partial<UsageBucket>): UsageBucket => ({
  day: UsageDay.make("2026-10-01"),
  provider: "claude",
  model: "claude-opus-5-5",
  totals: {
    uncachedInputTokens: 10,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: 1,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
  ...overrides,
});

const app = ProjectId.make("app");
const parent = ThreadId.make("parent");

function source(overrides: Partial<UsageExplorerSource> = {}): UsageExplorerSource {
  return {
    environmentId: "env-a",
    environmentLabel: "Laptop",
    projects: [{ projectId: app, title: "app" }],
    threads: [
      { key: "t3:parent", threadId: parent, title: "Ship it", projectId: app, located: true },
      {
        key: "agent:claude:s:a",
        title: "Explore",
        projectId: app,
        parent: 0,
        subagent: true,
        located: true,
      },
      { key: "session:codex:x", located: true },
      { key: "session:claude:y", located: false },
    ],
    buckets: [
      bucket({ thread: 0, costUsd: 5, instanceId: "claude-work" }),
      bucket({ thread: 1, costUsd: 2 }),
      bucket({ thread: 2, costUsd: 1, provider: "codex", model: "gpt-6-sol" }),
      bucket({ thread: 3, costUsd: 1 }),
      bucket({ costUsd: 1, provider: "cursor", model: "auto" }),
    ],
    ...overrides,
  };
}

describe("buildExplorerData", () => {
  it("places every bucket in a project, thread and account", () => {
    const data = buildExplorerData([source()]);
    const byProject = foldFacts(data.facts, (fact) => fact.project);

    expect(byProject.get("env-a\u001fapp")?.costUsd).toBe(7);
    expect(byProject.get(OUTSIDE_PROJECTS)?.costUsd).toBe(1);
    // Unlocated sessions and buckets without a thread are unknown, not outside.
    expect(byProject.get(UNKNOWN_PROJECT)?.costUsd).toBe(2);
    expect(data.facts[0]?.account).toBe("env-a\u001fclaude-work");
    expect(data.facts[1]?.account).toBe("env-a\u001fclaude");
    expect(data.threads.parentOf.get("env-a\u001fagent:claude:s:a")).toBe("env-a\u001ft3:parent");
  });

  it("names same-titled projects from two environments apart", () => {
    const data = buildExplorerData([
      source(),
      source({ environmentId: "env-b", environmentLabel: "Desktop" }),
    ]);
    expect(data.projectNames.get("env-a\u001fapp")).toBe("app · Laptop");
    expect(data.projectNames.get("env-b\u001fapp")).toBe("app · Desktop");
  });

  it("does not nest a thread under a parent in another project", () => {
    const data = buildExplorerData([
      source({
        projects: [
          { projectId: app, title: "app" },
          { projectId: ProjectId.make("docs"), title: "docs" },
        ],
        threads: [
          { key: "t3:p", title: "Parent", projectId: app, located: true },
          {
            key: "t3:c",
            title: "Child",
            projectId: ProjectId.make("docs"),
            parent: 0,
            located: true,
          },
        ],
        buckets: [bucket({ thread: 0 }), bucket({ thread: 1 })],
      }),
    ]);
    expect(data.threads.parentOf.size).toBe(0);
  });
});

describe("thread identity", () => {
  it("keeps a thread's key when another window lists threads in another order", () => {
    const first = buildExplorerData([source()]);
    const reordered = buildExplorerData([
      source({
        threads: [
          { key: "session:claude:y", located: false },
          { key: "t3:parent", threadId: parent, title: "Ship it", projectId: app, located: true },
        ],
        buckets: [bucket({ thread: 1, costUsd: 5 })],
      }),
    ]);
    expect(reordered.facts[0]?.thread).toBe(first.facts[0]?.thread);
  });
});

describe("thread families", () => {
  it("rolls sub-agent usage into the thread that started it", () => {
    const data = buildExplorerData([source()]);
    const families = familyTotals(data.facts, data.threads);
    expect(families.get("env-a\u001ft3:parent")).toMatchObject({ costUsd: 7, descendants: 1 });
    expect(keyFor("thread", data.facts[1]!, data.threads)).toBe("env-a\u001ft3:parent");
  });
});

describe("series", () => {
  const totals = (cost: number) => ({ ...emptyTotals(), input: 1, costUsd: cost, records: 1 });

  it("colours the top eight and stacks the rest as Other", () => {
    const map = new Map(Array.from({ length: 10 }, (_, i) => [`k${i}`, totals(10 - i)]));
    const { series, seriesOf } = buildSeries(map, map, "cost");
    expect(series).toHaveLength(9);
    expect(series[8]).toMatchObject({ key: OTHER_SERIES, members: ["k8", "k9"] });
    expect(seriesOf("k9")).toBe(OTHER_SERIES);
    expect(series[0]?.color).toBe(SERIES_PALETTE[0]);
  });

  it("keeps an item's colour when a filter changes the ranking", () => {
    const all = new Map([
      ["big", totals(100)],
      ["small", totals(1)],
    ]);
    const filtered = new Map([["small", totals(1)]]);
    const { colorOf } = buildSeries(filtered, all, "cost");
    // "small" keeps the second palette slot it holds over all history.
    expect(colorOf("small")).toBe(SERIES_PALETTE[1]);
  });
});

describe("chartColumns", () => {
  it("adds up from the start of the range for a running total", () => {
    const facts = buildExplorerData([
      source({
        buckets: [
          bucket({ day: UsageDay.make("2026-10-01"), costUsd: 2 }),
          bucket({ day: UsageDay.make("2026-10-02"), costUsd: 3 }),
        ],
      }),
    ]).facts;
    const columns = chartColumns({
      facts,
      bins: ["2026-10-01", "2026-10-02"],
      series: [{ key: "claude", color: "red", members: ["claude"] }],
      seriesOf: (fact) => fact.provider,
      binOf: (fact) => fact.time,
      metric: "cost",
      running: true,
    });
    expect(columns.map((column) => [column.total, column.own])).toEqual([
      [2, 2],
      [5, 3],
    ]);
  });

  it("aligns six-hour intervals to the local clock", () => {
    // 05:30 UTC is 15:30 in Sydney (AEST, UTC+10 on this date).
    expect(binKey("2026-07-01T05:00:00.000Z", 360, "Australia/Sydney")).toBe("2026-07-01T12");
    expect(binKey("2026-07-01T05:00:00.000Z", 1440, "Australia/Sydney")).toBe("2026-07-01");
  });
});

describe("rankEntries", () => {
  it("pins favourites, then sorts by the chosen column", () => {
    const data = buildExplorerData([source()]);
    const byModel = foldFacts(data.facts, (fact) => fact.model);
    const ranked = rankEntries(byModel, {
      metric: "cost",
      sort: { column: "name", descending: false },
      nameOf: (key) => key,
      pinned: new Set(["gpt-6-sol"]),
    });
    expect(ranked.map((entry) => entry.key)).toEqual(["gpt-6-sol", "auto", "claude-opus-5-5"]);
  });
});

describe("toCsv", () => {
  it("quotes fields and defuses spreadsheet formulas", () => {
    expect(toCsv([["=SUM(A1)", 'a "b", c', 3]])).toBe(`'=SUM(A1),"a ""b"", c",3\n`);
  });
});

describe("buildBreakdownRows", () => {
  const data = buildExplorerData([source()]);
  const input = (overrides: Partial<Parameters<typeof buildBreakdownRows>[0]> = {}) => ({
    dimension: "project" as const,
    facts: data.facts,
    tree: data.threads,
    metric: "cost" as const,
    sort: null,
    nameOf: (_: string, key: string) =>
      data.projectNames.get(key) ?? data.threads.info.get(key)?.title ?? key,
    nounOf: (_: string, count: number) => `${count} things`,
    seriesOf: (key: string) => key,
    colorOf: () => "red",
    hidden: new Set<string>(),
    favorites: new Set<string>(),
    accountsOfProvider: () => 1,
    open: new Set<string>(),
    showAll: new Set<string>(),
    query: "",
    ...overrides,
  });

  it("opens a project to its threads and a thread to its main conversation and sub-agents", () => {
    const projectPath = "project\u0002env-a\u001fapp";
    const threadPath = `${projectPath}\u0001thread\u0002env-a\u001ft3:parent`;
    const rows = buildBreakdownRows(input({ open: new Set([projectPath, threadPath]) }));
    const labels = rows.map((row) =>
      row.kind === "item" ? `${row.depth}:${row.dimension}` : `${row.depth}:${row.kind}`,
    );
    expect(labels.slice(0, 4)).toEqual(["0:project", "1:thread", "2:leaf", "2:thread"]);
    const thread = rows[1];
    expect(thread?.kind === "item" && thread.subagents).toBe(1);
    expect(thread?.kind === "item" && thread.share).toBeCloseTo(1);
  });

  it("folds two or more grey rows into Other, but leaves a lone one plain", () => {
    const grey = (key: string) => (key === "env-a\u001fapp" ? key : OTHER_SERIES);
    const rows = buildBreakdownRows(input({ seriesOf: grey }));
    const other = rows.find((row) => row.kind === "other");
    expect(other?.kind === "other" && other.members).toHaveLength(2);

    const one = (key: string) => (key === UNKNOWN_PROJECT ? OTHER_SERIES : key);
    expect(buildBreakdownRows(input({ seriesOf: one })).some((row) => row.kind === "other")).toBe(
      false,
    );
  });

  it("pages a long Other group", () => {
    const many = buildExplorerData([
      source({
        projects: Array.from({ length: 30 }, (_, i) => ({
          projectId: ProjectId.make(`p${i}`),
          title: `p${i}`,
        })),
        threads: Array.from({ length: 30 }, (_, i) => ({
          key: `t3:${i}`,
          projectId: ProjectId.make(`p${i}`),
          located: true,
        })),
        buckets: Array.from({ length: 30 }, (_, i) => bucket({ thread: i, costUsd: 30 - i })),
      }),
    ]);
    const rows = buildBreakdownRows(
      input({
        facts: many.facts,
        tree: many.threads,
        seriesOf: () => OTHER_SERIES,
        open: new Set(["\u0000other"]),
      }),
    );
    expect(rows.filter((row) => row.kind === "item")).toHaveLength(10);
    expect(rows.at(-1)).toMatchObject({ kind: "more", hiddenCount: 20 });
  });

  it("lists usage outside any thread when a project is opened", () => {
    const unknownPath = `project\u0002${UNKNOWN_PROJECT}`;
    const rows = buildBreakdownRows(input({ open: new Set([unknownPath]) }));
    const start = rows.findIndex((row) => row.kind === "item" && row.key === UNKNOWN_PROJECT);
    const children = rows.slice(start + 1).filter((row) => row.depth === 1);
    // The unlocated session is a thread; Cursor's usage has none.
    expect(children.map((row) => (row.kind === "leaf" ? row.label : row.kind))).toEqual([
      "item",
      "Not in a thread",
    ]);
  });

  it("can collapse the top-level list again", () => {
    const many = buildExplorerData([
      source({
        projects: Array.from({ length: 12 }, (_, i) => ({
          projectId: ProjectId.make(`p${i}`),
          title: `p${i}`,
        })),
        threads: Array.from({ length: 12 }, (_, i) => ({
          key: `t3:${i}`,
          projectId: ProjectId.make(`p${i}`),
          located: true,
        })),
        buckets: Array.from({ length: 12 }, (_, i) => bucket({ thread: i, costUsd: 12 - i })),
      }),
    ]);
    const rows = buildBreakdownRows(
      input({ facts: many.facts, tree: many.threads, showAll: new Set(["\u0000top"]) }),
    );
    expect(rows.at(-1)).toMatchObject({ kind: "fewer", target: "\u0000top" });
  });

  it("opens the path down to a sub-agent that matches the search", () => {
    const rows = buildBreakdownRows(input({ query: "explore" }));
    expect(rows.map((row) => (row.kind === "item" ? row.key : row.kind))).toEqual([
      "env-a\u001fapp",
      "env-a\u001ft3:parent",
      "leaf",
      "env-a\u001fagent:claude:s:a",
    ]);
  });

  it("finds a model by name from the Projects and Providers views", () => {
    const byProject = buildBreakdownRows(input({ query: "gpt-6" }));
    // The Codex session is unattributed (outside projects), so only its project row stays.
    expect(byProject.filter((row) => row.kind === "item").map((row) => row.key)).toEqual([
      OUTSIDE_PROJECTS,
      "env-a\u001fsession:codex:x",
    ]);
    const byProvider = buildBreakdownRows(
      input({ dimension: "provider", query: "gpt-6", nameOf: (_: string, key: string) => key }),
    );
    expect(byProvider.filter((row) => row.kind === "item").map((row) => row.key)).toEqual([
      "codex",
      "codex\u001fgpt-6-sol",
    ]);
  });
});

import type { DecisionItem, EnvironmentId, ScheduleJob, ThreadBrief } from "@cz/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { FleetMachine } from "../fleet.ts";
import {
  buildMorningBrief,
  formatBriefSince,
  machineProblem,
  morningBriefIsEmpty,
  morningBriefSummary,
} from "./morningBrief.ts";

const f = "env-f" as EnvironmentId;
const basement = "env-basement" as EnvironmentId;
const HOUR = 3_600_000;
const since = 1_000 * HOUR;

const decision = (id: string, overrides: Partial<DecisionItem> = {}) => ({
  environmentId: f,
  item: {
    id,
    project: "czcode",
    kind: "pick",
    status: "open",
    blocking: false,
    priority: 0,
    cost_note: null,
    created_at: 1,
    ...overrides,
  } as DecisionItem,
});

const thread = (
  id: string,
  waiting: boolean,
  overrides: { environmentId?: EnvironmentId; archivedAt?: string; running?: boolean } = {},
) => ({
  environmentId: overrides.environmentId ?? f,
  id,
  title: id,
  archivedAt: overrides.archivedAt ?? null,
  latestRun: { completedAt: overrides.running ? null : "2026-10-08T04:00:00.000Z" },
  hasPendingApprovals: false,
  hasPendingUserInput: waiting,
});

const machineBrief = (
  groups: ReadonlyArray<[ThreadBrief["groups"][number]["kind"], string, string, string[]]>,
  overrides: Partial<ThreadBrief> = {},
): ThreadBrief => ({
  since,
  lines: "written",
  groups: groups.map(([kind, label, text, ids]) => ({
    kind,
    label,
    text,
    action: kind === "stopped" ? "dismiss" : "open",
    threads: ids.map((threadId) => ({ threadId, title: threadId })),
  })),
  ...overrides,
});

const job = (id: string, overrides: Partial<ScheduleJob>): ScheduleJob => ({
  id,
  source: "systemd",
  what: id,
  project: null,
  unit: `${id}.timer`,
  schedule: "Daily 04:00",
  lastRun: { status: "ok", at: since + HOUR, reason: null },
  lastScheduledRun: null,
  nextRunAt: null,
  output: null,
  registered: true,
  ...overrides,
});

const machine = (overrides: Partial<FleetMachine>): FleetMachine => ({
  environmentId: f,
  label: "f",
  state: "awake",
  resources: null,
  warnings: [],
  agents: [],
  ...overrides,
});

describe("buildMorningBrief", () => {
  const brief = buildMorningBrief({
    machines: [
      {
        environmentId: f,
        brief: machineBrief([
          ["done", "hll", "Andras rigged in game", ["a"]],
          ["failed", "Usage limit", "Claude hit its limit", ["b"]],
          ["stopped", "Stopped", "Lavrov likeness half written", ["c"]],
          ["done", "kit", "Android fixes landed", ["archived"]],
          ["failed", "Provider error", "Codex crashed", ["restarted"]],
        ]),
      },
      {
        environmentId: basement,
        brief: machineBrief([["done", "hll", "level editor parts 2-7 merged", ["d"]]], {
          since: since - HOUR,
          lines: "pending",
        }),
      },
      { environmentId: "env-mac" as EnvironmentId, brief: null },
    ],
    decisions: [
      decision("old", { created_at: 1 }),
      decision("hll", { created_at: 5, project: "hll" }),
      decision("agent-waiting", { created_at: 10, blocking: true }),
      decision("answered", { status: "answered" }),
    ],
    threads: [
      thread("asking", true),
      thread("a", false),
      thread("b", false),
      thread("c", false),
      thread("d", false, { environmentId: basement }),
      thread("archived", false, { archivedAt: "2026-10-08T05:00:00.000Z" }),
      thread("restarted", false, { running: true }),
    ],
    jobs: [
      job("backup", { lastRun: { status: "failed", at: since + HOUR, reason: "disk full" } }),
      job("before", { lastRun: { status: "failed", at: since - 2 * HOUR, reason: "old" } }),
    ].map((entry) => ({ environmentId: f, job: entry })),
    fleet: [
      machine({ label: "basement", state: "unreachable" }),
      machine({ label: "mac", state: "asleep" }),
    ],
  });

  it("merges one project across machines into one line", () => {
    expect(brief.done).toHaveLength(1);
    expect(brief.done[0]?.text).toBe("Andras rigged in game; level editor parts 2-7 merged");
    expect(brief.done[0]?.threads.map((t) => `${t.environmentId}:${t.threadId}`)).toEqual([
      "env-f:a",
      "env-basement:d",
    ]);
  });

  it("drops threads archived or restarted since the brief was written", () => {
    const labels = [...brief.done, ...brief.failed].map((line) => line.label);
    expect(labels).not.toContain("kit");
    expect(labels).not.toContain("Provider error");
  });

  it("lists failures, then a failed job since the earliest look, then stopped runs", () => {
    expect(brief.since).toBe(since - HOUR);
    expect(brief.failed.map((line) => [line.kind, line.label, line.text])).toEqual([
      ["failed", "Usage limit", "Claude hit its limit"],
      ["failed", "Scheduled job", "backup: disk full"],
      ["stopped", "Stopped", "Lavrov likeness half written"],
    ]);
    expect(brief.writing).toBe(true);
  });

  it("says what needs the owner and which machines are in trouble", () => {
    expect(brief.decisions.total).toBe(3);
    expect(brief.decisions.top?.item.id).toBe("agent-waiting");
    expect(brief.decisions.byProject).toEqual([
      { project: "czcode", count: 2 },
      { project: "hll", count: 1 },
    ]);
    expect(brief.waiting.map((t) => t.id)).toEqual(["asking"]);
    expect(brief.machines.map((m) => `${m.label} ${m.problem}`)).toEqual(["basement offline"]);
    expect(morningBriefSummary(brief)).toBe(
      "hll done · 2 failed · 1 stopped · 3 Decisions · 1 thread waiting · basement offline",
    );
  });

  it("is empty when nothing happened and nothing waits", () => {
    expect(
      morningBriefIsEmpty(
        buildMorningBrief({
          machines: [{ environmentId: f, brief: machineBrief([]) }],
          decisions: [],
          threads: [thread("idle", false)],
          jobs: [],
          fleet: [machine({})],
        }),
      ),
    ).toBe(true);
  });
});

describe("machineProblem", () => {
  const resources = {
    sampledAt: 0,
    cpuUtilization: 1,
    cpuCount: 8,
    availableMemoryBytes: 1,
    totalMemoryBytes: 2,
  };
  it("flags a machine that's offline, overloaded, or short of room", () => {
    expect(machineProblem(machine({ state: "busy" }))).toBe("online but not answering: overloaded");
    expect(machineProblem(machine({ resources: { ...resources, loadAverage: [20, 9, 8] } }))).toBe(
      "overloaded: load 20 on 8 cores",
    );
    expect(
      machineProblem(
        machine({
          resources,
          warnings: [{ kind: "disk", mount: "/", freeBytes: 1, freeRatio: 0.04 }],
        }),
      ),
    ).toBe("disk / 4% free");
    expect(machineProblem(machine({ state: "asleep" }))).toBeNull();
    expect(machineProblem(machine({ resources: { ...resources, loadAverage: [9] } }))).toBeNull();
  });
});

describe("formatBriefSince", () => {
  const denver = DateTime.zoneMakeNamedUnsafe("America/Denver");
  const local = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
  const now = local("2026-10-08T09:30:00-06:00");
  it("says the time, and the day when it wasn't today", () => {
    expect(formatBriefSince(local("2026-10-08T07:05:00-06:00"), now, denver)).toBe("07:05");
    expect(formatBriefSince(local("2026-10-07T18:04:00-06:00"), now, denver)).toBe(
      "yesterday 18:04",
    );
    expect(formatBriefSince(local("2026-10-05T18:04:00-06:00"), now, denver)).toBe("Mon 18:04");
  });
});

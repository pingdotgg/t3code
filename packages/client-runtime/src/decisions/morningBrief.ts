/**
 * The Morning brief: one card at the top of Needs you saying what happened
 * since the owner last looked, for the machines the filter shows. What got
 * done (by project), what failed (by cause) or was stopped, what needs them,
 * and machine trouble. Each machine's server writes its own lines
 * (MorningBriefService); this merges them with the Decisions, waiting
 * threads, and fleet health the client already has. Shared by web and mobile.
 *
 * Sorts with `.sort` on fresh arrays, not `.toSorted`: the phone's Hermes
 * engine has no `toSorted`.
 *
 * @module morningBrief
 */
import type {
  DecisionItem,
  EnvironmentId,
  ScheduleJob,
  ScheduleJobRun,
  ThreadBrief,
} from "@cz/contracts";

import * as DateTime from "effect/DateTime";

import type { FleetMachine } from "../fleet.ts";

export interface BriefMachine {
  readonly environmentId: EnvironmentId;
  /** Null while the machine's brief is loading or it isn't answering. */
  readonly brief: ThreadBrief | null;
}

export interface BriefDecision {
  readonly environmentId: EnvironmentId;
  readonly item: DecisionItem;
}

export interface BriefWaitingThread {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly title: string;
  readonly archivedAt: string | null;
  /** A run under way has no `completedAt`. */
  readonly latestRun: { readonly completedAt: string | null } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

export interface BriefJob {
  readonly environmentId: EnvironmentId;
  readonly job: ScheduleJob;
}

export interface BriefThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly title: string;
}

/** One line of the brief, with the threads it is about. */
export interface BriefLine {
  readonly key: string;
  readonly kind: "done" | "failed" | "stopped";
  /** The project for done work ("hll"), the cause for failures ("Usage limit"). */
  readonly label: string;
  readonly text: string;
  readonly action: ThreadBrief["groups"][number]["action"];
  readonly threads: ReadonlyArray<BriefThreadRef>;
  /** Scheduled jobs that failed, for the "Scheduled job" line. */
  readonly jobs: ReadonlyArray<BriefJob & { readonly run: ScheduleJobRun }>;
}

export interface MorningBrief<T extends BriefWaitingThread> {
  /** Epoch ms of the earliest "last looked" across the machines, or null before any answered. */
  readonly since: number | null;
  readonly done: ReadonlyArray<BriefLine>;
  /** Failed, then stopped. */
  readonly failed: ReadonlyArray<BriefLine>;
  /** True while a machine's model is still writing, so its lines are counts for now. */
  readonly writing: boolean;
  readonly decisions: {
    readonly total: number;
    /** "2 hll, 1 czcode", most first. */
    readonly byProject: ReadonlyArray<{ readonly project: string; readonly count: number }>;
    /** The one that matters most: an agent waiting, then money, then the oldest. */
    readonly top: BriefDecision | null;
  };
  /** Threads waiting on an approval or an answer. */
  readonly waiting: ReadonlyArray<T>;
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly problem: string;
  }>;
}

/** How much a waiting decision matters: an agent blocked on it, then money, then oldest. */
function compareImportance(a: DecisionItem, b: DecisionItem): number {
  return (
    Number(b.blocking) - Number(a.blocking) ||
    Number(b.cost_note !== null) - Number(a.cost_note !== null) ||
    a.created_at - b.created_at
  );
}

/** Load above this many runnable tasks per core is overloaded. */
const OVERLOAD_PER_CORE = 1.5;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/**
 * What's wrong with a machine, in a few words, or null when nothing is. A
 * machine that sleeps when idle and can be woken is not trouble.
 */
export function machineProblem(machine: FleetMachine): string | null {
  if (machine.state === "unreachable") return "offline";
  if (machine.state === "busy") return "online but not answering: overloaded";
  if (machine.state !== "awake" || machine.resources === null) return null;
  const load = machine.resources.loadAverage?.[0];
  const cores = machine.resources.cpuCount;
  if (load !== undefined && cores > 0 && load > cores * OVERLOAD_PER_CORE) {
    return `overloaded: load ${Math.round(load)} on ${cores} cores`;
  }
  const warning = machine.warnings[0];
  if (warning === undefined) return null;
  switch (warning.kind) {
    case "disk":
      return `disk ${warning.mount} ${percent(warning.freeRatio)} free`;
    case "memory":
      return `memory ${percent(warning.usedRatio)} used`;
    case "swap":
      return `swap ${percent(warning.usedRatio)} used`;
  }
}

/**
 * Builds the brief. `machines`, `threads`, `jobs` and `fleet` are already
 * limited to the machines the feed shows; `decisions` are the open ones it shows.
 * A thread the owner archived or restarted since the server wrote its brief drops out.
 */
export function buildMorningBrief<T extends BriefWaitingThread>(input: {
  readonly machines: ReadonlyArray<BriefMachine>;
  readonly decisions: ReadonlyArray<BriefDecision>;
  readonly threads: ReadonlyArray<T>;
  readonly jobs: ReadonlyArray<BriefJob>;
  readonly fleet: ReadonlyArray<FleetMachine>;
}): MorningBrief<T> {
  const answered = input.machines.flatMap((machine) =>
    machine.brief === null ? [] : [{ environmentId: machine.environmentId, brief: machine.brief }],
  );
  const since =
    answered.length === 0 ? null : Math.min(...answered.map((machine) => machine.brief.since));

  const ended = new Set(
    input.threads.flatMap((thread) =>
      thread.archivedAt === null && thread.latestRun?.completedAt
        ? [`${thread.environmentId}:${thread.id}`]
        : [],
    ),
  );
  // The same project or cause on two machines is one line.
  const lines = new Map<string, BriefLine>();
  for (const { environmentId, brief } of answered) {
    for (const group of brief.groups) {
      const key = `${group.kind}:${group.label}`;
      const line = lines.get(key);
      const threads = group.threads
        .filter((thread) => ended.has(`${environmentId}:${thread.threadId}`))
        .map((thread) => ({ environmentId, ...thread }));
      if (threads.length === 0) continue;
      lines.set(
        key,
        line === undefined
          ? { key, ...group, threads, jobs: [] }
          : {
              ...line,
              text: line.text.includes(group.text) ? line.text : `${line.text}; ${group.text}`,
              threads: [...line.threads, ...threads],
            },
      );
    }
  }

  const failedJobs = input.jobs.flatMap((entry) => {
    if (!entry.job.registered || since === null) return [];
    const run = [entry.job.lastScheduledRun, entry.job.lastRun].find(
      (candidate) =>
        candidate?.status === "failed" && candidate.at !== null && candidate.at >= since,
    );
    return run ? [{ ...entry, run }] : [];
  });
  if (failedJobs.length > 0) {
    lines.set("failed:jobs", {
      key: "failed:jobs",
      kind: "failed",
      label: failedJobs.length === 1 ? "Scheduled job" : "Scheduled jobs",
      text: failedJobs
        .map(({ job, run }) => (run.reason ? `${job.what}: ${run.reason}` : job.what))
        .join("; "),
      action: "open",
      threads: [],
      jobs: failedJobs,
    });
  }

  const open = input.decisions.filter((entry) => entry.item.status === "open");
  const counts = new Map<string, number>();
  for (const entry of open) {
    counts.set(entry.item.project, (counts.get(entry.item.project) ?? 0) + 1);
  }

  const all = [...lines.values()];
  return {
    since,
    done: all.filter((line) => line.kind === "done"),
    failed: [
      ...all.filter((line) => line.kind === "failed"),
      ...all.filter((line) => line.kind === "stopped"),
    ],
    writing: answered.some((machine) => machine.brief.lines === "pending"),
    decisions: {
      total: open.length,
      byProject: [...counts]
        .map(([project, count]) => ({ project, count }))
        .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project)),
      top: [...open].sort((a, b) => compareImportance(a.item, b.item))[0] ?? null,
    },
    waiting: input.threads.filter(
      (thread) =>
        thread.archivedAt === null && (thread.hasPendingApprovals || thread.hasPendingUserInput),
    ),
    machines: input.fleet.flatMap((machine) => {
      const problem = machineProblem(machine);
      return problem === null
        ? []
        : [{ environmentId: machine.environmentId, label: machine.label, problem }];
    }),
  };
}

/** True when there is nothing to say. */
export function morningBriefIsEmpty(brief: MorningBrief<BriefWaitingThread>): boolean {
  return (
    brief.done.length === 0 &&
    brief.failed.length === 0 &&
    brief.decisions.total === 0 &&
    brief.waiting.length === 0 &&
    brief.machines.length === 0
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** How many threads or jobs a line covers. */
export function briefLineCount(line: BriefLine): number {
  return line.threads.length + line.jobs.length;
}

/** The folded line: "hll, czcode done · 2 failed · 3 Decisions · basement offline". */
export function morningBriefSummary(brief: MorningBrief<BriefWaitingThread>): string {
  const total = (kind: BriefLine["kind"]) =>
    brief.failed
      .filter((line) => line.kind === kind)
      .reduce((sum, line) => sum + briefLineCount(line), 0);
  const failed = total("failed");
  const stopped = total("stopped");
  return [
    brief.done.length > 0 ? `${brief.done.map((line) => line.label).join(", ")} done` : null,
    failed > 0 ? `${failed} failed` : null,
    stopped > 0 ? `${stopped} stopped` : null,
    brief.decisions.total > 0 ? plural(brief.decisions.total, "Decision") : null,
    brief.waiting.length > 0 ? `${plural(brief.waiting.length, "thread")} waiting` : null,
    ...brief.machines.map((machine) => `${machine.label} ${machine.problem}`),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "18:04", "yesterday 18:04", or "Tue 18:04", in local time. */
export function formatBriefSince(
  since: number,
  now: number,
  timeZone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
): string {
  const zoned = DateTime.makeZonedUnsafe(since, { timeZone });
  const parts = DateTime.toParts(zoned);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(parts.hour)}:${pad(parts.minute)}`;
  const today = DateTime.toEpochMillis(
    DateTime.startOf(DateTime.makeZonedUnsafe(now, { timeZone }), "day"),
  );
  if (since >= today) return time;
  if (since >= today - 24 * 60 * 60_000) return `yesterday ${time}`;
  return `${WEEKDAYS[parts.weekDay]} ${time}`;
}

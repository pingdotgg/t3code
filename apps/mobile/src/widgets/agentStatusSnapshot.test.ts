import {
  presentThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeRawThreadShell } from "../test-fixtures";
import type { AgentActivityPhase } from "./AgentActivity";
import {
  AGENT_STATUS_FRESH_MS,
  agentStatusRows,
  agentStatusDisplayKey,
  agentStatusTimeline,
  buildAgentStatusSnapshot,
  type AgentStatusRow,
} from "./agentStatusSnapshot";

const now = Date.parse("2026-10-31T18:42:00.000Z");
const live = EnvironmentId.make("moonbase");
const offline = EnvironmentId.make("laptop");
const projectId = ProjectId.make("t3code");

function project(environmentId: EnvironmentId): EnvironmentProject {
  return { environmentId, id: projectId, title: "T3 Code" } as EnvironmentProject;
}

function shell(
  id: string,
  raw: Partial<OrchestrationV2ThreadShell>,
  presented: Partial<EnvironmentThreadShell> = {},
  environmentId = live,
): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return {
    ...presentThreadShell(
      environmentId,
      makeRawThreadShell({ id: threadId, projectId, title: id, ...raw }),
    ),
    ...presented,
  };
}

function row(title: string, phase: AgentActivityPhase, minutesAgo: number): AgentStatusRow {
  return {
    threadTitle: title,
    projectTitle: "T3 Code",
    phase,
    updatedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    deepLink: `/threads/moonbase/${encodeURIComponent(title)}`,
  };
}

const finished = (completedAt: string, lastVisitedAt: string) => ({
  latestRun: {
    runId: "run" as never,
    status: "completed" as const,
    requestedAt: null,
    startedAt: null,
    completedAt,
    assistantMessageId: null,
  },
  lastVisitedAt,
});

describe("agent status widget snapshots", () => {
  it("projects threads the way the relay does, from live environments only", () => {
    const rows = agentStatusRows({
      threads: [
        shell("approval", {
          status: "running",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(now),
          },
        }),
        shell("running", { status: "running" }),
        shell(
          "unseen-done",
          { status: "completed" },
          finished("2026-10-31T18:40:00Z", "2026-10-31T18:00:00Z"),
        ),
        shell(
          "seen-done",
          { status: "completed" },
          finished("2026-10-31T18:00:00Z", "2026-10-31T18:30:00Z"),
        ),
        shell("idle", { status: "idle" }),
        shell("archived", { status: "running" }, { archivedAt: "2026-10-31T18:00:00Z" }),
        shell("offline", { status: "running" }, {}, offline),
      ],
      projects: [project(live), project(offline)],
      liveEnvironmentIds: new Set([live]),
    });

    expect(rows.map((candidate) => [candidate.threadTitle, candidate.phase])).toEqual([
      ["approval", "waiting_for_approval"],
      ["running", "running"],
      ["unseen-done", "completed"],
    ]);
    expect(rows[0]?.deepLink).toBe("/threads/moonbase/approval");
  });

  it("leads with the thread that needs the user and opens it", () => {
    const snapshot = buildAgentStatusSnapshot(
      [
        row("Update snapshots", "completed", 0),
        row("Polish copy", "running", 0),
        row("Fix login redirect", "waiting_for_approval", 3),
        row("Flaky test", "failed", 1),
        row("Answer me", "waiting_for_input", 1),
      ],
      { now },
    );

    expect(snapshot.threads.map((thread) => thread.title)).toEqual([
      "Answer me",
      "Fix login redirect",
      "Flaky test",
      "Polish copy",
      "Update snapshots",
    ]);
    expect(snapshot.threads[0]?.url).toBe("t3code://threads/moonbase/Answer%20me");
    expect(snapshot.url).toBe("t3code://");
  });

  it("counts every thread, including those past the widget's rows", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, index) => row(`Working ${index}`, "running", index)),
      row("Fix login redirect", "waiting_for_input", 20),
      row("Update snapshots", "completed", 0),
      row("Flaky test", "failed", 0),
    ];
    const snapshot = buildAgentStatusSnapshot(rows, { now });

    expect(snapshot.counts).toEqual({ needsYou: 1, working: 9, failed: 1, done: 1 });
    expect(snapshot.threads).toHaveLength(8);
    expect(snapshot.threads[0]?.title).toBe("Fix login redirect");
  });

  it("re-renders the widget once the snapshot can no longer vouch for running work", () => {
    const snapshot = buildAgentStatusSnapshot([row("Polish copy", "running", 0)], { now });

    expect(snapshot.checkedAt).toBe(now);
    expect(agentStatusTimeline(snapshot).map((entry) => entry.date.getTime())).toEqual([
      now,
      now + AGENT_STATUS_FRESH_MS,
    ]);
    expect(snapshot.expiresAt).toBe(now + AGENT_STATUS_FRESH_MS);
  });

  it("opens a thread whose ID needs escaping exactly once", () => {
    const [threadRow] = agentStatusRows({
      threads: [shell("fix%2Flogin redirect", { status: "running" })],
      projects: [project(live)],
      liveEnvironmentIds: new Set([live]),
    });
    const url = buildAgentStatusSnapshot(threadRow ? [threadRow] : [], { now }).threads[0]?.url;

    expect(url).toBe("t3code://threads/moonbase/fix%252Flogin%20redirect");
    expect(decodeURIComponent(url?.split("/").at(-1) ?? "")).toBe("fix%2Flogin redirect");
  });

  it("republishes only when what the widget shows changes", () => {
    const rows = [row("Polish copy", "running", 0), row("Fix login redirect", "running", 5)];
    const touched = rows.map((entry) => ({ ...entry, updatedAt: new Date(now).toISOString() }));

    expect(agentStatusDisplayKey(touched)).toBe(agentStatusDisplayKey(rows));
    const failed = [row("Polish copy", "running", 0), row("Fix login redirect", "failed", 5)];
    expect(agentStatusDisplayKey(failed)).not.toBe(agentStatusDisplayKey(rows));
  });
});

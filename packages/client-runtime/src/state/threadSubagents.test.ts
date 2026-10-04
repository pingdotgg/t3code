import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { withSubagentThreadActivity } from "./subagentRuntime.ts";
import { deriveThreadTurnSubagents, resolveSubagentPillSegment } from "./threadSubagents.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
): OrchestrationV2Subagent {
  const { id, ...rest } = overrides;
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("node-1"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make("thread-child"),
    nativeTaskRef: null,
    prompt: "Do the thing",
    title: "Worker",
    model: "gpt-5.4",
    status: "running",
    result: null,
    startedAt: at("2026-06-20T00:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-06-20T00:00:01.000Z"),
    ...rest,
  };
}

const run = (id: string, status: "running" | "completed") =>
  ({ id: RunId.make(id), status }) as never;
const activeRun = run("run-1", "running");
const finishedRun = run("run-1", "completed");

describe("deriveThreadTurnSubagents", () => {
  it("returns null when the thread has never spawned an agent", () => {
    expect(deriveThreadTurnSubagents({ runs: [activeRun], subagents: [] })).toBeNull();
  });

  it("scopes the roster to the active run and orders it by start time", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "b", startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent({ id: "old", runId: RunId.make("run-0") }),
        subagent({ id: "a", startedAt: at("2026-06-20T00:00:02.000Z") }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(turn?.turnActive).toBe(true);
  });

  it("falls back to the most recently updated agent's run once the turn settles", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [
        subagent({ id: "old", status: "completed", updatedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({
          id: "recent",
          runId: RunId.make("run-2"),
          status: "completed",
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-2");
    expect(turn?.turnActive).toBe(false);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["recent"]);
  });

  it("counts idle as neither working nor done", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "idle" }),
        subagent({ id: "c", status: "failed" }),
      ],
    });

    expect(turn?.liveCount).toBe(1);
    expect(turn?.settledCount).toBe(1);
    expect(turn?.subagents).toHaveLength(3);
  });
});

describe("resolveSubagentPillSegment", () => {
  it("shows how many of the turn's agents are still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "waiting" }),
        subagent({ id: "c", status: "completed" }),
      ],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "2/3",
      accessibilityLabel: "2 of 3 agents working",
    });
  });

  it("reports the finished roster while the turn is still running", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "1 done",
      accessibilityLabel: "1 agent done",
    });
  });

  it("hides itself once the turn is over and nothing is working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toBeNull();
    expect(resolveSubagentPillSegment(null)).toBeNull();
  });

  it("stays visible after the turn ends while an agent is still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "running" })],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/1");
  });
});

describe("delegated child follow-ups", () => {
  const completed = subagent({
    id: "finished",
    status: "completed",
    result: "Original result",
    completedAt: at("2026-06-20T00:01:00Z"),
  });
  const child = {
    ...v2ThreadShell,
    id: completed.childThreadId!,
    status: "running" as const,
    activityRunStatus: "running" as const,
    activityRunStartedAt: at("2026-06-20T00:02:00Z"),
  };

  it.each(["queued", "preparing", "starting", "running", "waiting"] as const)(
    "shows a %s follow-up as live without changing its original result",
    (status) => {
      const live = withSubagentThreadActivity(completed, {
        ...child,
        status,
        activityRunStatus: null,
      });
      expect(live.status).toBe(
        ["queued", "preparing", "starting"].includes(status) ? "pending" : status,
      );
      expect(live.result).toBeNull();
      expect(live.completedAt).toBeNull();
      expect(live.startedAt).toEqual(child.activityRunStartedAt);
      expect(completed.result).toBe("Original result");
      expect(completed.status).toBe("completed");
    },
  );

  it("includes a resumed agent from an earlier parent run and removes it after it settles", () => {
    const projection = {
      runs: [finishedRun, run("run-2", "running")],
      subagents: [completed, subagent({ id: "current", runId: RunId.make("run-2") })],
    };
    const children = new Map<ThreadId, OrchestrationV2ThreadShell>([[child.id, child]]);
    const live = deriveThreadTurnSubagents(projection, children);
    expect(live?.subagents.map((agent) => agent.id)).toEqual(["current", "finished"]);
    expect(live?.liveCount).toBe(2);
    children.set(child.id, { ...child, status: "completed", activityRunStatus: null });
    expect(
      deriveThreadTurnSubagents(projection, children)?.subagents.map((agent) => agent.id),
    ).toEqual(["current"]);
  });

  it("keeps provider-owned and unavailable children on their task status", () => {
    expect(
      withSubagentThreadActivity({ ...completed, origin: "provider_native" }, child).status,
    ).toBe("completed");
    expect(withSubagentThreadActivity(completed, undefined)).toBe(completed);
    expect(withSubagentThreadActivity(completed, { ...child, archivedAt: child.createdAt })).toBe(
      completed,
    );
  });
});

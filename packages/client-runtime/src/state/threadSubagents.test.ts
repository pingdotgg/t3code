import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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

const run = (id: string, status: "running" | "completed" | "rolled_back") =>
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
        subagent({ id: "old", runId: RunId.make("run-0"), status: "completed" }),
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

  it("lists every live agent from earlier turns once no turn is running", () => {
    const turn = deriveThreadTurnSubagents({
      runs: ["run-103", "run-105", "run-107", "run-109"].map((id) => run(id, "completed")),
      subagents: [
        subagent({
          id: "settled-103",
          runId: RunId.make("run-103"),
          status: "completed",
          startedAt: at("2026-06-20T00:00:00.000Z"),
          updatedAt: at("2026-06-20T00:00:04.000Z"),
        }),
        subagent({
          id: "bg-103",
          runId: RunId.make("run-103"),
          startedAt: at("2026-06-20T00:00:01.000Z"),
          updatedAt: at("2026-06-20T00:00:05.000Z"),
        }),
        subagent({
          id: "bg-105",
          runId: RunId.make("run-105"),
          startedAt: at("2026-06-20T00:00:02.000Z"),
          updatedAt: at("2026-06-20T00:00:06.000Z"),
        }),
        subagent({
          id: "bg-107",
          runId: RunId.make("run-107"),
          startedAt: at("2026-06-20T00:00:03.000Z"),
          updatedAt: at("2026-06-20T00:00:07.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["bg-103", "bg-105", "bg-107"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("3/3");
  });

  it("keeps the active turn's roster and adds a live agent from an earlier turn", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "background", runId: RunId.make("run-0") }),
        subagent({ id: "earlier-done", runId: RunId.make("run-0"), status: "completed" }),
        subagent({ id: "working", startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent({
          id: "done",
          status: "completed",
          startedAt: at("2026-06-20T00:00:06.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.turnActive).toBe(true);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["background", "working", "done"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("2/3");
  });

  it("leaves out a live agent whose turn was rolled back", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "rolled_back"), finishedRun],
      subagents: [
        subagent({ id: "rolled-back", runId: RunId.make("run-0") }),
        subagent({ id: "live", updatedAt: at("2026-06-20T00:00:09.000Z") }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["live"]);
  });

  it("does not pick a rolled-back turn when its agent was updated last", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "rolled_back"), finishedRun],
      subagents: [
        subagent({
          id: "rolled-back",
          runId: RunId.make("run-0"),
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
        subagent({
          id: "done",
          status: "completed",
          updatedAt: at("2026-06-20T00:00:05.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["done"]);
    expect(
      deriveThreadTurnSubagents({
        runs: [run("run-0", "rolled_back")],
        subagents: [subagent({ id: "rolled-back", runId: RunId.make("run-0") })],
      }),
    ).toBeNull();
  });

  it("lists a workflow coordinator's members, which carry no run", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [],
      subagents: [
        subagent({ id: "member-0", runId: null, startedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({
          id: "member-1",
          runId: null,
          status: "completed",
          startedAt: at("2026-06-20T00:00:02.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["member-0", "member-1"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/2");
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

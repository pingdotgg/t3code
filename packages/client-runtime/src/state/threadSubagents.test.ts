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

const run = (
  id: string,
  status: "queued" | "running" | "completed" | "cancelled" | "rolled_back",
  overrides: { readonly ordinal?: number; readonly started?: boolean } = {},
) =>
  ({
    id: RunId.make(id),
    status,
    ordinal: overrides.ordinal ?? Number(id.slice("run-".length)),
    startedAt: overrides.started === false ? null : at("2026-06-20T00:00:00.000Z"),
  }) as never;
const activeRun = run("run-1", "running");
const finishedRun = run("run-1", "completed");

describe("deriveThreadTurnSubagents", () => {
  it.each(["running", "completed"] as const)(
    "keeps finished workflows after a later %s turn",
    (status) => {
      const workflow = subagent({
        id: "workflow",
        status: "completed",
        workflow: { phases: [], agents: [] },
      });
      const turn = deriveThreadTurnSubagents({
        runs: [finishedRun, run("run-2", status)],
        subagents: [
          workflow,
          subagent({ id: "old", status: "completed" }),
          subagent({
            id: "recent",
            runId: RunId.make("run-2"),
            status,
            updatedAt: at("2026-06-20T00:00:09.000Z"),
          }),
        ],
      });

      expect(turn?.subagents.map((entry) => entry.id)).toEqual(["recent", "workflow"]);
      expect(resolveSubagentPillSegment(turn)).not.toBeNull();
    },
  );

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

  it("keeps the finished agents reachable while their turn is the latest", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [
        subagent({ id: "a", status: "completed" }),
        subagent({ id: "b", status: "failed" }),
      ],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("2 done");
  });

  it("drops finished agents from the pill once a later turn ran without any", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toBeNull();
  });

  it("shows finished agents again when the later turn was rolled back", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "rolled_back")],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("1 done");
  });

  it("keeps finished agents while a later turn is only queued or was cancelled before starting", () => {
    for (const later of [
      run("run-2", "queued", { started: false }),
      run("run-2", "cancelled", { started: false }),
    ]) {
      const turn = deriveThreadTurnSubagents({
        runs: [finishedRun, later],
        subagents: [subagent({ id: "a", status: "completed" })],
      });

      expect(resolveSubagentPillSegment(turn)?.label).toBe("1 done");
    }
  });

  it("finds the latest turn by ordinal when a reordered queue left runs out of order", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-1", "completed", { ordinal: 3 }), run("run-2", "completed", { ordinal: 2 })],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("1 done");
  });

  it("keeps the latest turn's agents when an earlier turn's background agent finishes later", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [
        subagent({ id: "late", status: "completed", updatedAt: at("2026-06-20T00:00:09.000Z") }),
        subagent({
          id: "latest",
          runId: RunId.make("run-2"),
          status: "completed",
          updatedAt: at("2026-06-20T00:00:05.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["latest"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1 done");
  });

  it("counts only terminal agents as done while a held agent remains", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [
        subagent({ id: "a", status: "completed" }),
        subagent({ id: "b", status: "idle" }),
      ],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("1 done");
  });

  it("counts idle as neither working nor done", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "completed" }),
        subagent({ id: "b", status: "idle" }),
        subagent({ id: "c", status: "failed" }),
      ],
    });

    expect(turn?.liveCount).toBe(0);
    expect(turn?.settledCount).toBe(2);
    expect(turn?.subagents).toHaveLength(3);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("2 done");
  });

  it("keeps settled workflows reachable without counting idle agents as done", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [
        subagent({ id: "workflow", status: "completed", workflow: { phases: [], agents: [] } }),
        subagent({
          id: "idle",
          runId: RunId.make("run-2"),
          status: "idle",
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["idle", "workflow"]);
    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "1 done",
      accessibilityLabel: "1 agent done",
    });
  });
});

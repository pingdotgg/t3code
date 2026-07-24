import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-23T12:00:00.000Z";

const makeReadModel = (monitor: OrchestrationThread["monitor"] = null): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/repo",
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      monitor,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
});

const activeMonitor: NonNullable<OrchestrationThread["monitor"]> = {
  prNumber: 42,
  status: "monitoring",
  blockersSummary: "waiting",
  headSha: "abc",
  wakeCount: 0,
  startedAt: NOW,
  endedAt: null,
  endedReason: null,
};

const commandId = (value: string) => CommandId.make(value);
const threadId = ThreadId.make("thread-1");

it.layer(NodeServices.layer)("monitor decider", (it) => {
  it.effect("starts and idempotently re-emits the same PR", () =>
    Effect.gen(function* () {
      const start = {
        type: "thread.monitor.start" as const,
        commandId: commandId("start"),
        threadId,
        prNumber: 42,
        blockersSummary: "",
        headSha: "abc",
        createdAt: NOW,
      };
      const event = yield* decideOrchestrationCommand({
        command: start,
        readModel: makeReadModel(),
      });
      expect("type" in event ? event.type : event[0]?.type).toBe("thread.monitor-started");
      const repeated = yield* decideOrchestrationCommand({
        command: { ...start, commandId: commandId("again"), headSha: "new" },
        readModel: makeReadModel(activeMonitor),
      });
      if ("type" in repeated && repeated.type === "thread.monitor-started") {
        const payload = repeated.payload as {
          readonly headSha: string;
          readonly startedAt: string;
        };
        expect(payload.headSha).toBe("abc");
        expect(payload.startedAt).toBe(NOW);
      }
    }),
  );

  it.effect("rejects a different PR and updates/ends only an active monitor", () =>
    Effect.gen(function* () {
      const different = yield* decideOrchestrationCommand({
        command: {
          type: "thread.monitor.start",
          commandId: commandId("different"),
          threadId,
          prNumber: 43,
          blockersSummary: "",
          headSha: "def",
          createdAt: NOW,
        },
        readModel: makeReadModel(activeMonitor),
      }).pipe(Effect.flip);
      expect(different._tag).toBe("OrchestrationCommandInvariantError");

      const update = yield* decideOrchestrationCommand({
        command: {
          type: "thread.monitor.update",
          commandId: commandId("update"),
          threadId,
          blockersSummary: "CI",
          headSha: "def",
          wakeCount: 1,
          updatedAt: NOW,
        },
        readModel: makeReadModel(activeMonitor),
      });
      expect("type" in update ? update.type : update[0]?.type).toBe(
        "thread.monitor-snapshot-updated",
      );
      const end = yield* decideOrchestrationCommand({
        command: {
          type: "thread.monitor.end",
          commandId: commandId("end"),
          threadId,
          reason: "ready",
          blockersSummary: "",
          endedAt: NOW,
        },
        readModel: makeReadModel(activeMonitor),
      });
      expect("type" in end ? end.type : end[0]?.type).toBe("thread.monitor-ended");
    }),
  );

  it.effect("rejects update/end without an active monitor and settle ends monitoring", () =>
    Effect.gen(function* () {
      for (const command of [
        {
          type: "thread.monitor.update" as const,
          commandId: commandId("bad-update"),
          threadId,
          blockersSummary: "",
          headSha: "abc",
          wakeCount: 0,
          updatedAt: NOW,
        },
        {
          type: "thread.monitor.end" as const,
          commandId: commandId("bad-end"),
          threadId,
          reason: "stopped" as const,
          blockersSummary: "",
          endedAt: NOW,
        },
      ]) {
        const error = yield* decideOrchestrationCommand({
          command,
          readModel: makeReadModel(),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
      const settled = yield* decideOrchestrationCommand({
        command: { type: "thread.settle", commandId: commandId("settle"), threadId },
        readModel: makeReadModel(activeMonitor),
      });
      expect(Array.isArray(settled) ? settled.map((event) => event.type) : []).toEqual([
        "thread.monitor-ended",
        "thread.settled",
      ]);
    }),
  );
});

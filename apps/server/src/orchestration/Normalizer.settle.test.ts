import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-08-28T12:00:00.000Z";

function makeThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: ThreadId.make(id),
      status: "ready",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const idle = makeThread("idle");
const threads = [
  idle,
  makeThread("running", { session: { ...idle.session!, status: "running" } }),
  // The turn ended, but a watch loop still runs.
  makeThread("watching", { backgroundLiveness: "monitoring" }),
  makeThread("question", { hasPendingUserInput: true }),
  makeThread("approval", { hasPendingApprovals: true }),
];

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-settle-" }),
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (threadId) =>
      threadId === "unreadable"
        ? Effect.fail(new PersistenceSqlError({ operation: "getThreadShellById" }))
        : Effect.succeed(Option.fromUndefinedOr(threads.find((thread) => thread.id === threadId))),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("normalizeDispatchCommand settle", (it) => {
  it.effect("settles later instead of stopping a working thread", () =>
    Effect.gen(function* () {
      const settle = (threadId: string) =>
        normalizeDispatchCommand({
          type: "thread.settle",
          commandId: CommandId.make(`settle-${threadId}`),
          threadId: ThreadId.make(threadId),
        }).pipe(Effect.map((command) => command.type));
      expect(yield* settle("idle")).toBe("thread.settle");
      expect(yield* settle("running")).toBe("thread.settle-when-idle");
      expect(yield* settle("watching")).toBe("thread.settle-when-idle");
      // An unreadable thread may still be working, so it waits as well.
      expect(yield* settle("unreadable")).toBe("thread.settle-when-idle");
    }),
  );

  it.effect(
    "preserves manual dismissal of message questions while blocking native questions and approvals",
    () =>
      Effect.gen(function* () {
        for (const request of ["message", "native", "approval"] as const) {
          const shell = threads.find(
            (thread) => thread.id === (request === "approval" ? "approval" : "question"),
          )!;
          const command = yield* normalizeDispatchCommand({
            type: "thread.settle",
            commandId: CommandId.make(`settle-${request}`),
            threadId: shell.id,
          });
          expect(command.type).toBe("thread.settle");
          const decision = decideOrchestrationCommand({
            command,
            readModel: {
              snapshotSequence: 0,
              projects: [],
              updatedAt: NOW,
              threads: [
                {
                  ...shell,
                  deletedAt: null,
                  messages: [],
                  checkpoints: [],
                  proposedPlans: [],
                  activities: [
                    {
                      id: EventId.make(`request-${request}`),
                      kind: request === "approval" ? "approval.requested" : "user-input.requested",
                      summary: "Response needed",
                      tone: "approval",
                      turnId: null,
                      createdAt: NOW,
                      payload: {
                        requestId: request,
                        ...(request === "message" ? { responseMode: "message" } : {}),
                      },
                    },
                  ],
                },
              ],
            },
          });
          if (request !== "message") {
            expect((yield* decision.pipe(Effect.flip))._tag).toBe(
              "OrchestrationThreadSettleBlockedError",
            );
            continue;
          }
          const result = yield* decision;
          const events = Array.isArray(result) ? result : [result];
          expect(events.map((event) => event.type)).toEqual([
            "thread.settled",
            "thread.activity-appended",
          ]);
          expect(events[1]?.payload).toMatchObject({
            activity: {
              kind: "user-input.resolved",
              payload: { requestId: "message", responseMode: "message" },
            },
          });
        }
      }),
  );
});

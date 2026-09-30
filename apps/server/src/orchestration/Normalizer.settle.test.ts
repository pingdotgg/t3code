import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
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
];

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-settle-" }),
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (threadId) =>
      Effect.succeed(Option.fromUndefinedOr(threads.find((thread) => thread.id === threadId))),
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
    }),
  );
});

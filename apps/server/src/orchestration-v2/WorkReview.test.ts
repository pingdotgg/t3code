import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for work review"),
  respondToRuntimeRequest: () => Effect.void,
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  IdAllocator.layer,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "work-review" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:work-review");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-work-review"),
    threadId,
    projectId: ProjectId.make("project:work-review"),
    title: "Work review",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return orchestrator;
});

it.layer(layerTest)("work review via pending runtime requests", (it) => {
  it.effect("blocks settle while pending, then settles after accept", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;

      yield* orchestrator.dispatch({
        type: "work-review.request",
        commandId: CommandId.make("work-review-request"),
        threadId,
        criteria: "Diff matches the acceptance criteria.",
        name: "Reviewer",
      });

      let projection = yield* orchestrator.getThreadProjection(threadId);
      const pending = projection.runtimeRequests.find(
        (request) => request.kind === "work_review" && request.status === "pending",
      );
      assert.isDefined(pending);
      assert.equal(pending?.responseCapability.type, "orchestration");
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.pendingRuntimeRequest?.kind,
        "work_review",
      );

      const settleWhileOpen = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-while-open"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(settleWhileOpen._tag, "OrchestratorDispatchError");
      assert.match(String(settleWhileOpen.cause), /approval or question/);

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("work-review-accept"),
        threadId,
        requestId: pending!.id,
        decision: "accept",
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      const accepted = projection.runtimeRequests.find((request) => request.id === pending!.id);
      assert.equal(accepted?.status, "resolved");
      assert.equal(accepted?.decision, "accept");
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.pendingRuntimeRequest,
        null,
      );

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-after-accept"),
        threadId,
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "settled");
    }),
  );

  it.effect("decline clears the ask so settle works; re-request can ask again", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;

      yield* orchestrator.dispatch({
        type: "work-review.request",
        commandId: CommandId.make("work-review-request-reject"),
        threadId,
        criteria: "Missing tests should fail review.",
        name: "QA",
      });
      let projection = yield* orchestrator.getThreadProjection(threadId);
      const pending = projection.runtimeRequests.find(
        (request) => request.kind === "work_review" && request.status === "pending",
      );
      assert.isDefined(pending);

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("work-review-decline"),
        threadId,
        requestId: pending!.id,
        decision: "decline",
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      const declined = projection.runtimeRequests.find((request) => request.id === pending!.id);
      assert.equal(declined?.status, "resolved");
      assert.equal(declined?.decision, "decline");
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.pendingRuntimeRequest,
        null,
      );

      // Decline means not finished for the worker, but the card is gone so settlement is allowed.
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-after-decline"),
        threadId,
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.settledOverride, "settled");

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle-for-rerequest"),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        type: "work-review.request",
        commandId: CommandId.make("work-review-rerequest"),
        threadId,
        criteria: "Tests added; please re-review.",
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      const rerequested = projection.runtimeRequests.filter(
        (request) => request.kind === "work_review" && request.status === "pending",
      );
      assert.equal(rerequested.length, 1);
      assert.notEqual(rerequested[0]?.id, pending!.id);
    }),
  );
});

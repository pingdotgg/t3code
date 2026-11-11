import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProofJudgeId,
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
  openSession: () => Effect.die("No provider process needed for proof judges"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "proof-judges" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:proof-judges");
const judgeId = ProofJudgeId.make("proof-judge:reviewer");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-proof-judges"),
    threadId,
    projectId: ProjectId.make("project:proof-judges"),
    title: "Proof",
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

it.layer(layerTest)("proof judges request → accept / reject → reopen", (it) => {
  it.effect("blocks settle while requested, then clears after accept", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;

      yield* orchestrator.dispatch({
        type: "proof-judge.request",
        commandId: CommandId.make("proof-judge-request"),
        threadId,
        judgeId,
        name: "Reviewer",
        criteria: "Diff matches the acceptance criteria.",
        requestedByThreadId: threadId,
      });

      let projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.thread.proofJudges?.map((judge) => ({
          id: judge.id,
          name: judge.name,
          status: judge.status,
        })),
        [{ id: judgeId, name: "Reviewer", status: "requested" }],
      );
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.openProofJudgeCount,
        1,
      );

      const settleWhileOpen = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-while-open"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(settleWhileOpen._tag, "OrchestratorDispatchError");
      assert.match(String(settleWhileOpen.cause), /open proof judge/);

      yield* orchestrator.dispatch({
        type: "proof-judge.accept",
        commandId: CommandId.make("proof-judge-accept"),
        threadId,
        judgeId,
        note: "Looks good.",
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.proofJudges?.[0]?.status, "accepted");
      assert.equal(projection.thread.proofJudges?.[0]?.decidedBy, "user");
      assert.equal(projection.thread.proofJudges?.[0]?.note, "Looks good.");
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.openProofJudgeCount,
        0,
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

  it.effect("keeps rejected open until reopen, then allows accept", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const rejectedId = ProofJudgeId.make("proof-judge:rejected");
      yield* orchestrator.dispatch({
        type: "proof-judge.request",
        commandId: CommandId.make("proof-judge-request-reject"),
        threadId,
        judgeId: rejectedId,
        name: "QA",
        criteria: "",
        requestedByThreadId: threadId,
      });
      yield* orchestrator.dispatch({
        type: "proof-judge.reject",
        commandId: CommandId.make("proof-judge-reject"),
        threadId,
        judgeId: rejectedId,
        note: "Missing tests.",
        actorThreadId: threadId,
      });
      let projection = yield* orchestrator.getThreadProjection(threadId);
      const rejected = projection.thread.proofJudges?.find((judge) => judge.id === rejectedId);
      assert.equal(rejected?.status, "rejected");
      assert.equal(rejected?.decidedBy, threadId);
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.openProofJudgeCount,
        1,
      );

      const settleWhileRejected = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-while-rejected"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.match(String(settleWhileRejected.cause), /open proof judge/);

      yield* orchestrator.dispatch({
        type: "proof-judge.reopen",
        commandId: CommandId.make("proof-judge-reopen"),
        threadId,
        judgeId: rejectedId,
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      const reopened = projection.thread.proofJudges?.find((judge) => judge.id === rejectedId);
      assert.equal(reopened?.status, "requested");
      assert.equal(reopened?.decidedBy, null);
      assert.equal(reopened?.note, null);

      yield* orchestrator.dispatch({
        type: "proof-judge.accept",
        commandId: CommandId.make("proof-judge-accept-after-reopen"),
        threadId,
        judgeId: rejectedId,
      });
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.openProofJudgeCount,
        0,
      );
    }),
  );

  it.effect("rejects a second accept while already accepted", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const onceId = ProofJudgeId.make("proof-judge:once");
      yield* orchestrator.dispatch({
        type: "proof-judge.request",
        commandId: CommandId.make("proof-judge-request-once"),
        threadId,
        judgeId: onceId,
        name: "Once",
        criteria: "",
        requestedByThreadId: threadId,
      });
      yield* orchestrator.dispatch({
        type: "proof-judge.accept",
        commandId: CommandId.make("proof-judge-accept-once"),
        threadId,
        judgeId: onceId,
      });
      const error = yield* orchestrator
        .dispatch({
          type: "proof-judge.accept",
          commandId: CommandId.make("proof-judge-accept-twice"),
          threadId,
          judgeId: onceId,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.match(String(error.cause), /must be requested before accept/);
    }),
  );
});

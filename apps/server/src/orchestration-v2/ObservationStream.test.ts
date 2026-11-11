import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ObservationItemId,
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
  openSession: () => Effect.die("No provider process needed for observation stream"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "observation-stream" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const homeThreadId = ThreadId.make("thread:observation-home");
const seatThreadId = ThreadId.make("thread:observation-seat");
const workThreadId = ThreadId.make("thread:observation-work");
const itemId = ObservationItemId.make("observation:intake-001");
const otherItemId = ObservationItemId.make("observation:intake-002");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-observation-home"),
    threadId: homeThreadId,
    projectId: ProjectId.make("project:observation"),
    title: "Intake",
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

it.layer(layerTest)("observation stream append → subscribe → act", (it) => {
  it.effect("keeps intake durable and separate from owned obligations", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;

      yield* orchestrator.dispatch({
        type: "observation.append",
        commandId: CommandId.make("observation-append"),
        threadId: homeThreadId,
        itemId,
        title: "Flaky reconnect on mobile",
        body: "Seen twice after backgrounding the app.",
        createdByThreadId: homeThreadId,
      });
      yield* orchestrator.dispatch({
        type: "observation.append",
        commandId: CommandId.make("observation-append-other"),
        threadId: homeThreadId,
        itemId: otherItemId,
        title: "Same flaky reconnect",
        body: "Likely the same report.",
        createdByThreadId: homeThreadId,
      });

      let projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.deepEqual(
        projection.thread.observationItems?.map((item) => ({
          id: item.id,
          status: item.status,
        })),
        [
          { id: itemId, status: "open" },
          { id: otherItemId, status: "open" },
        ],
      );
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === homeThreadId,
        )?.openObservationCount,
        2,
      );

      yield* orchestrator.dispatch({
        type: "observation.subscribe",
        commandId: CommandId.make("observation-subscribe"),
        threadId: homeThreadId,
        subscriberThreadId: seatThreadId,
      });
      projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.deepEqual(projection.thread.observationStreamSubscribers, [seatThreadId]);

      yield* orchestrator.dispatch({
        type: "observation.link-work",
        commandId: CommandId.make("observation-link"),
        threadId: homeThreadId,
        itemId,
        linkedThreadId: workThreadId,
        actorThreadId: seatThreadId,
      });
      projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.equal(projection.thread.observationItems?.[0]?.status, "linked");
      assert.equal(projection.thread.observationItems?.[0]?.linkedThreadId, workThreadId);
      assert.equal(projection.thread.observationItems?.[0]?.actedByThreadId, seatThreadId);
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === homeThreadId,
        )?.openObservationCount,
        1,
      );

      yield* orchestrator.dispatch({
        type: "observation.duplicate",
        commandId: CommandId.make("observation-duplicate"),
        threadId: homeThreadId,
        itemId: otherItemId,
        duplicateOfObservationId: itemId,
        actorThreadId: seatThreadId,
      });
      projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.equal(projection.thread.observationItems?.[1]?.status, "duplicated");
      assert.equal(projection.thread.observationItems?.[1]?.duplicateOfObservationId, itemId);
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === homeThreadId,
        )?.openObservationCount,
        0,
      );
    }),
  );

  it.effect("rejects acting on a closed observation and self-duplicates", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const declinedId = ObservationItemId.make("observation:decline-once");
      yield* orchestrator.dispatch({
        type: "observation.append",
        commandId: CommandId.make("observation-append-decline"),
        threadId: homeThreadId,
        itemId: declinedId,
        title: "Noise",
        body: "",
        createdByThreadId: homeThreadId,
      });
      yield* orchestrator.dispatch({
        type: "observation.decline",
        commandId: CommandId.make("observation-decline"),
        threadId: homeThreadId,
        itemId: declinedId,
        actorThreadId: seatThreadId,
      });
      const closed = yield* orchestrator
        .dispatch({
          type: "observation.link-work",
          commandId: CommandId.make("observation-link-closed"),
          threadId: homeThreadId,
          itemId: declinedId,
          linkedThreadId: workThreadId,
          actorThreadId: seatThreadId,
        })
        .pipe(Effect.flip);
      assert.equal(closed._tag, "OrchestratorDispatchError");
      assert.match(String(closed.cause), /already closed/);

      const openId = ObservationItemId.make("observation:self-dup");
      yield* orchestrator.dispatch({
        type: "observation.append",
        commandId: CommandId.make("observation-append-self"),
        threadId: homeThreadId,
        itemId: openId,
        title: "Self",
        body: "",
        createdByThreadId: homeThreadId,
      });
      const selfDup = yield* orchestrator
        .dispatch({
          type: "observation.duplicate",
          commandId: CommandId.make("observation-self-dup"),
          threadId: homeThreadId,
          itemId: openId,
          duplicateOfObservationId: openId,
          actorThreadId: seatThreadId,
        })
        .pipe(Effect.flip);
      assert.equal(selfDup._tag, "OrchestratorDispatchError");
      assert.match(String(selfDup.cause), /duplicate of itself/);
    }),
  );
});

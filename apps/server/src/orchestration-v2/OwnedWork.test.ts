import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OwnedWorkItemId,
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
  openSession: () => Effect.die("No provider process needed for owned work"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "owned-work" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const homeThreadId = ThreadId.make("thread:owned-work-home");
const assigneeThreadId = ThreadId.make("thread:owned-work-assignee");
const handoffThreadId = ThreadId.make("thread:owned-work-handoff");
const itemId = OwnedWorkItemId.make("owned-work:feature-001");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-owned-work-home"),
    threadId: homeThreadId,
    projectId: ProjectId.make("project:owned-work"),
    title: "Lead",
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

it.layer(layerTest)("owned work assign → claim → progress → handoff", (it) => {
  it.effect("keeps ownership durable on the home thread after each step", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;

      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign"),
        threadId: homeThreadId,
        itemId,
        title: "Ship shared client",
        description: "Record progress on the reconnect path.",
        assigneeThreadId,
        createdByThreadId: homeThreadId,
      });

      let projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.deepEqual(
        projection.thread.ownedWorkItems?.map((item) => ({
          id: item.id,
          status: item.status,
          assigneeThreadId: item.assigneeThreadId,
          claimedByThreadId: item.claimedByThreadId,
        })),
        [
          {
            id: itemId,
            status: "assigned",
            assigneeThreadId,
            claimedByThreadId: null,
          },
        ],
      );
      const shell = yield* orchestrator.getShellSnapshot();
      const homeShell = shell.threads.find((thread) => thread.id === homeThreadId);
      assert.equal(homeShell?.openOwnedWorkCount, 1);

      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-claim"),
        threadId: homeThreadId,
        itemId,
        claimedByThreadId: assigneeThreadId,
      });
      projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.equal(projection.thread.ownedWorkItems?.[0]?.status, "claimed");
      assert.equal(projection.thread.ownedWorkItems?.[0]?.claimedByThreadId, assigneeThreadId);

      yield* orchestrator.dispatch({
        type: "owned-work.progress",
        commandId: CommandId.make("owned-work-progress"),
        threadId: homeThreadId,
        itemId,
        progress: "Reconnect helper drafted.",
        actorThreadId: assigneeThreadId,
      });
      projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.equal(projection.thread.ownedWorkItems?.[0]?.status, "in_progress");
      assert.equal(projection.thread.ownedWorkItems?.[0]?.progress, "Reconnect helper drafted.");

      yield* orchestrator.dispatch({
        type: "owned-work.handoff",
        commandId: CommandId.make("owned-work-handoff"),
        threadId: homeThreadId,
        itemId,
        toThreadId: handoffThreadId,
        note: "Needs review on auth edge cases.",
        actorThreadId: assigneeThreadId,
      });
      projection = yield* orchestrator.getThreadProjection(homeThreadId);
      const item = projection.thread.ownedWorkItems?.[0];
      assert.equal(item?.status, "handed_off");
      assert.equal(item?.assigneeThreadId, handoffThreadId);
      assert.equal(item?.claimedByThreadId, null);
      assert.equal(item?.handoffNote, "Needs review on auth edge cases.");
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === homeThreadId,
        )?.openOwnedWorkCount,
        1,
      );

      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-reclaim"),
        threadId: homeThreadId,
        itemId,
        claimedByThreadId: handoffThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.complete",
        commandId: CommandId.make("owned-work-complete"),
        threadId: homeThreadId,
        itemId,
        closureReason: "no_follow_on",
        closureNote: "Diff landed; nothing else to hand on.",
        actorThreadId: handoffThreadId,
      });
      projection = yield* orchestrator.getThreadProjection(homeThreadId);
      assert.equal(projection.thread.ownedWorkItems?.[0]?.status, "completed");
      assert.equal(projection.thread.ownedWorkItems?.[0]?.closureReason, "no_follow_on");
      assert.equal(
        projection.thread.ownedWorkItems?.[0]?.closureNote,
        "Diff landed; nothing else to hand on.",
      );
      assert.equal(
        (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === homeThreadId,
        )?.openOwnedWorkCount,
        0,
      );
    }),
  );

  it.effect("rejects a second claim while the first owner still holds it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign-once"),
        threadId: homeThreadId,
        itemId: OwnedWorkItemId.make("owned-work:once"),
        title: "Only one claimer",
        description: "",
        createdByThreadId: homeThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-claim-first"),
        threadId: homeThreadId,
        itemId: OwnedWorkItemId.make("owned-work:once"),
        claimedByThreadId: assigneeThreadId,
      });
      const error = yield* orchestrator
        .dispatch({
          type: "owned-work.claim",
          commandId: CommandId.make("owned-work-claim-second"),
          threadId: homeThreadId,
          itemId: OwnedWorkItemId.make("owned-work:once"),
          claimedByThreadId: handoffThreadId,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.match(String(error.cause), /not claimable/);
    }),
  );

  it.effect("refuses complete without a closure target when the reason needs one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const needsTargetId = OwnedWorkItemId.make("owned-work:needs-target");
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign-target"),
        threadId: homeThreadId,
        itemId: needsTargetId,
        title: "Needs a destination",
        description: "",
        createdByThreadId: homeThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-claim-target"),
        threadId: homeThreadId,
        itemId: needsTargetId,
        claimedByThreadId: assigneeThreadId,
      });
      const missingTarget = yield* orchestrator
        .dispatch({
          type: "owned-work.complete",
          commandId: CommandId.make("owned-work-complete-missing-target"),
          threadId: homeThreadId,
          itemId: needsTargetId,
          closureReason: "handed_off",
          actorThreadId: assigneeThreadId,
        })
        .pipe(Effect.flip);
      assert.equal(missingTarget._tag, "OrchestratorDispatchError");
      assert.match(String(missingTarget.cause), /closureTarget is required/);

      yield* orchestrator.dispatch({
        type: "owned-work.complete",
        commandId: CommandId.make("owned-work-complete-with-target"),
        threadId: homeThreadId,
        itemId: needsTargetId,
        closureReason: "handed_off",
        closureTarget: ThreadId.make("thread:next-stage"),
        actorThreadId: assigneeThreadId,
      });
      const projection = yield* orchestrator.getThreadProjection(homeThreadId);
      const item = projection.thread.ownedWorkItems?.find(
        (candidate) => candidate.id === needsTargetId,
      );
      assert.equal(item?.status, "completed");
      assert.equal(item?.closureReason, "handed_off");
      assert.equal(item?.closureTarget, "thread:next-stage");
    }),
  );

  it.effect("records cancel as closure reason canceled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* setup;
      const cancelId = OwnedWorkItemId.make("owned-work:cancel-me");
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign-cancel"),
        threadId: homeThreadId,
        itemId: cancelId,
        title: "Withdraw",
        description: "",
        createdByThreadId: homeThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.cancel",
        commandId: CommandId.make("owned-work-cancel"),
        threadId: homeThreadId,
        itemId: cancelId,
        closureNote: "Scope dropped.",
        actorThreadId: homeThreadId,
      });
      const projection = yield* orchestrator.getThreadProjection(homeThreadId);
      const item = projection.thread.ownedWorkItems?.find((candidate) => candidate.id === cancelId);
      assert.equal(item?.status, "cancelled");
      assert.equal(item?.closureReason, "canceled");
      assert.equal(item?.closureNote, "Scope dropped.");
    }),
  );
});

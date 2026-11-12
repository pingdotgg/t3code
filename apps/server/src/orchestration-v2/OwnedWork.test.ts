import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OwnedWorkItemId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  openOwnedWorkCountForThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OwnedWorkService from "./OwnedWorkService.ts";
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

const assigneeThreadId = ThreadId.make("thread:owned-work-assignee");
const handoffThreadId = ThreadId.make("thread:owned-work-handoff");
const itemId = OwnedWorkItemId.make("owned-work:feature-001");

const setup = (actorThreadId: ThreadId, projectId: ProjectId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${actorThreadId}`),
      threadId: actorThreadId,
      projectId,
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

const projectItems = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const ownedWork = yield* OwnedWorkService.OwnedWorkService;
    return (yield* ownedWork.list({ projectId })).items;
  });

const boardItem = (projectId: ProjectId, id: OwnedWorkItemId) =>
  projectItems(projectId).pipe(Effect.map((items) => items.find((item) => item.id === id)));

it.layer(layerTest)("owned work assign → claim → progress → handoff", (it) => {
  it.effect("keeps ownership durable on the project board after each step", () =>
    Effect.gen(function* () {
      const actorThreadId = ThreadId.make("thread:owned-work-home");
      const projectId = ProjectId.make("project:owned-work-main");
      const orchestrator = yield* setup(actorThreadId, projectId);
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign"),
        threadId: actorThreadId,
        projectId,
        itemId,
        title: "Ship shared client",
        description: "Record progress on the reconnect path.",
        assigneeThreadId,
        createdByThreadId: actorThreadId,
      });

      let item = yield* boardItem(projectId, itemId);
      assert.deepEqual(
        {
          id: item?.id,
          status: item?.status,
          projectId: item?.projectId,
          assigneeThreadId: item?.assigneeThreadId,
          claimedByThreadId: item?.claimedByThreadId,
        },
        {
          id: itemId,
          status: "assigned",
          projectId,
          assigneeThreadId,
          claimedByThreadId: null,
        },
      );
      assert.equal(item?.history?.[0]?.kind, "assigned");
      assert.equal(openOwnedWorkCountForThread(yield* projectItems(projectId), actorThreadId), 0);
      assert.equal(
        openOwnedWorkCountForThread(yield* projectItems(projectId), assigneeThreadId),
        1,
      );

      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-claim"),
        threadId: actorThreadId,
        projectId,
        itemId,
        claimedByThreadId: assigneeThreadId,
      });
      item = yield* boardItem(projectId, itemId);
      assert.equal(item?.status, "claimed");
      assert.equal(item?.claimedByThreadId, assigneeThreadId);

      yield* orchestrator.dispatch({
        type: "owned-work.progress",
        commandId: CommandId.make("owned-work-progress"),
        threadId: actorThreadId,
        projectId,
        itemId,
        progress: "Reconnect helper drafted.",
        actorThreadId: assigneeThreadId,
      });
      item = yield* boardItem(projectId, itemId);
      assert.equal(item?.status, "in_progress");
      assert.equal(item?.progress, "Reconnect helper drafted.");

      yield* orchestrator.dispatch({
        type: "owned-work.handoff",
        commandId: CommandId.make("owned-work-handoff"),
        threadId: actorThreadId,
        projectId,
        itemId,
        toThreadId: handoffThreadId,
        note: "Needs review on auth edge cases.",
        actorThreadId: assigneeThreadId,
      });
      item = yield* boardItem(projectId, itemId);
      assert.equal(item?.status, "handed_off");
      assert.equal(item?.assigneeThreadId, handoffThreadId);
      assert.equal(item?.claimedByThreadId, null);
      assert.equal(item?.handoffNote, "Needs review on auth edge cases.");
      assert.equal(openOwnedWorkCountForThread(yield* projectItems(projectId), handoffThreadId), 1);

      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-reclaim"),
        threadId: actorThreadId,
        projectId,
        itemId,
        claimedByThreadId: handoffThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.complete",
        commandId: CommandId.make("owned-work-complete"),
        threadId: actorThreadId,
        projectId,
        itemId,
        closureReason: "done",
        closureNote: "Diff landed.",
        actorThreadId: handoffThreadId,
      });
      item = yield* boardItem(projectId, itemId);
      assert.equal(item?.status, "completed");
      assert.equal(item?.closureReason, "done");
      assert.equal(item?.closureNote, "Diff landed.");
      assert.ok((item?.history?.length ?? 0) >= 5, "history remains after close");
      assert.equal(openOwnedWorkCountForThread(yield* projectItems(projectId), handoffThreadId), 0);
    }),
  );

  it.effect("rejects a second claim while the first owner still holds it", () =>
    Effect.gen(function* () {
      const actorThreadId = ThreadId.make("thread:owned-work-claim-once");
      const projectId = ProjectId.make("project:owned-work-claim-once");
      const orchestrator = yield* setup(actorThreadId, projectId);
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign-once"),
        threadId: actorThreadId,
        projectId,
        itemId: OwnedWorkItemId.make("owned-work:once"),
        title: "Only one claimer",
        description: "",
        createdByThreadId: actorThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-claim-first"),
        threadId: actorThreadId,
        projectId,
        itemId: OwnedWorkItemId.make("owned-work:once"),
        claimedByThreadId: assigneeThreadId,
      });
      const error = yield* orchestrator
        .dispatch({
          type: "owned-work.claim",
          commandId: CommandId.make("owned-work-claim-second"),
          threadId: actorThreadId,
          projectId,
          itemId: OwnedWorkItemId.make("owned-work:once"),
          claimedByThreadId: handoffThreadId,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.match(String(error.cause), /not claimable/);
    }),
  );

  it.effect("parks work on hold and resumes without closing the item", () =>
    Effect.gen(function* () {
      const actorThreadId = ThreadId.make("thread:owned-work-hold");
      const projectId = ProjectId.make("project:owned-work-hold");
      const orchestrator = yield* setup(actorThreadId, projectId);
      const holdId = OwnedWorkItemId.make("owned-work:hold-me");
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign-hold"),
        threadId: actorThreadId,
        projectId,
        itemId: holdId,
        title: "Waiting on review",
        description: "",
        createdByThreadId: actorThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-claim-hold"),
        threadId: actorThreadId,
        projectId,
        itemId: holdId,
        claimedByThreadId: assigneeThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.hold",
        commandId: CommandId.make("owned-work-hold"),
        threadId: actorThreadId,
        projectId,
        itemId: holdId,
        reason: "Blocked on API key from ops.",
        actorThreadId: assigneeThreadId,
      });
      let item = yield* boardItem(projectId, holdId);
      assert.equal(item?.status, "on_hold");
      assert.equal(item?.holdReason, "Blocked on API key from ops.");
      assert.equal(
        openOwnedWorkCountForThread(yield* projectItems(projectId), assigneeThreadId),
        1,
      );

      yield* orchestrator.dispatch({
        type: "owned-work.resume",
        commandId: CommandId.make("owned-work-resume"),
        threadId: actorThreadId,
        projectId,
        itemId: holdId,
        note: "Key landed.",
        actorThreadId: assigneeThreadId,
      });
      item = yield* boardItem(projectId, holdId);
      assert.equal(item?.status, "in_progress");
      assert.equal(item?.holdReason, null);
    }),
  );

  it.effect("refuses complete without a closure target when the reason needs one", () =>
    Effect.gen(function* () {
      const actorThreadId = ThreadId.make("thread:owned-work-closure-target");
      const projectId = ProjectId.make("project:owned-work-closure");
      const orchestrator = yield* setup(actorThreadId, projectId);
      const needsTargetId = OwnedWorkItemId.make("owned-work:needs-target");
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign-target"),
        threadId: actorThreadId,
        projectId,
        itemId: needsTargetId,
        title: "Needs a destination",
        description: "",
        createdByThreadId: actorThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.claim",
        commandId: CommandId.make("owned-work-claim-target"),
        threadId: actorThreadId,
        projectId,
        itemId: needsTargetId,
        claimedByThreadId: assigneeThreadId,
      });
      const missingTarget = yield* orchestrator
        .dispatch({
          type: "owned-work.complete",
          commandId: CommandId.make("owned-work-complete-missing-target"),
          threadId: actorThreadId,
          projectId,
          itemId: needsTargetId,
          closureReason: "handed_off",
          actorThreadId: assigneeThreadId,
        })
        .pipe(Effect.flip);
      assert.equal(missingTarget._tag, "OrchestratorDispatchError");
      assert.match(String(missingTarget.cause), /handoff target is required/);

      yield* orchestrator.dispatch({
        type: "owned-work.complete",
        commandId: CommandId.make("owned-work-complete-with-target"),
        threadId: actorThreadId,
        projectId,
        itemId: needsTargetId,
        closureReason: "handed_off",
        closureTarget: ThreadId.make("thread:next-stage"),
        actorThreadId: assigneeThreadId,
      });
      const item = yield* boardItem(projectId, needsTargetId);
      assert.equal(item?.status, "completed");
      assert.equal(item?.closureReason, "handed_off");
      assert.equal(item?.closureTarget, "thread:next-stage");
    }),
  );

  it.effect("records cancel as closure reason canceled", () =>
    Effect.gen(function* () {
      const actorThreadId = ThreadId.make("thread:owned-work-cancel");
      const projectId = ProjectId.make("project:owned-work-cancel");
      const orchestrator = yield* setup(actorThreadId, projectId);
      const cancelId = OwnedWorkItemId.make("owned-work:cancel-me");
      yield* orchestrator.dispatch({
        type: "owned-work.assign",
        commandId: CommandId.make("owned-work-assign-cancel"),
        threadId: actorThreadId,
        projectId,
        itemId: cancelId,
        title: "Drop this",
        description: "",
        createdByThreadId: actorThreadId,
      });
      yield* orchestrator.dispatch({
        type: "owned-work.cancel",
        commandId: CommandId.make("owned-work-cancel"),
        threadId: actorThreadId,
        projectId,
        itemId: cancelId,
        closureNote: "Superseded by another thread.",
        actorThreadId: actorThreadId,
      });
      const item = yield* boardItem(projectId, cancelId);
      assert.equal(item?.status, "cancelled");
      assert.equal(item?.closureReason, "canceled");
      assert.equal(item?.closureNote, "Superseded by another thread.");
      assert.equal(openOwnedWorkCountForThread(yield* projectItems(projectId), actorThreadId), 0);
    }),
  );
});

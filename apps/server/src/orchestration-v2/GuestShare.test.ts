import { assert, it } from "@effect/vitest";
import {
  CommandId,
  GuestMessageId,
  GuestShareId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  openSession: () => Effect.die("No provider process needed for guest shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guest-share" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const threadId = ThreadId.make("thread:guest-share");
const shareId = GuestShareId.make("share:one");
const guestMessageId = GuestMessageId.make("guest-message:one");

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-guest-share"),
    threadId,
    projectId: ProjectId.make("project:guest-share"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "thread.guest-share.open",
    commandId: CommandId.make("open-guest-share"),
    threadId,
    shareId,
    host: "env.t3.test",
    expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 24 })),
  });
  return orchestrator;
});

const sendGuestMessage = (orchestrator: Orchestrator.OrchestratorV2["Service"], id: string) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId,
    messageId: MessageId.make(id),
    guestMessageId,
    text: "ignored: the server sends the guest's own text",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });

it.effect("redeems a guest link once and sends each guest message once, with its turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const redeem = (id: string) =>
      orchestrator.dispatch({
        type: "thread.guest-share.redeem",
        commandId: CommandId.make(id),
        threadId,
        shareId,
        guestName: "Sam",
      });
    yield* redeem("redeem-1");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(redeem("redeem-2"))));

    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit-1"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why not keep the old cache?",
    });
    assert.equal((yield* projections.getThreadShell(threadId))?.pendingGuestMessageCount, 1);

    yield* sendGuestMessage(orchestrator, "send-1");
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(
      projection.thread.guestShare?.messages.map((message) => message.status),
      ["sent"],
    );
    const sent = projection.messages.find((message) => message.id === MessageId.make("send-1"));
    assert.equal(
      sent?.text,
      "Message from guest Sam, sent by the owner:\n\nWhy not keep the old cache?",
    );
    assert.deepEqual(sent?.context?.guest, {
      guestMessageId,
      name: "Sam",
      text: "Why not keep the old cache?",
      shareId,
    });
    assert.lengthOf(projection.runs, 1);
    assert.equal((yield* projections.getThreadShell(threadId))?.pendingGuestMessageCount, 0);

    // A second owner device clicking Send must not start another turn.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(sendGuestMessage(orchestrator, "send-2"))));
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).runs, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects guest messages until the link is redeemed and after archive", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const submit = orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit-early"),
      threadId,
      shareId,
      guestMessageId,
      text: "Hello",
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(submit)));

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-guest-share"),
      threadId,
    });
    assert.isNull((yield* projections.getThread(threadId)).guestShare ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("drops guest attribution that a client sends on its own message", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-message"),
      threadId,
      messageId: MessageId.make("owner-message"),
      text: "Mine",
      context: { version: 1, records: [], guest: { guestMessageId, name: "Sam", text: "Mine" } },
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* projections.getThreadProjection(threadId);
    const sent = projection.messages.find(
      (message) => message.id === MessageId.make("owner-message"),
    );
    assert.isUndefined(sent?.context?.guest);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a queued guest message unchanged when the owner tries to edit it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* setup;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-first"),
      threadId,
      messageId: MessageId.make("owner-first"),
      text: "Start",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: CommandId.make("redeem"),
      threadId,
      shareId,
      guestName: "Sam",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-message.submit",
      commandId: CommandId.make("submit"),
      threadId,
      shareId,
      guestMessageId,
      text: "Why?",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-queued"),
      threadId,
      messageId: MessageId.make("send-queued"),
      guestMessageId,
      text: "",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const queued = (yield* projections.getThreadProjection(threadId)).runs.find(
      (run) => run.status === "queued",
    );
    assert.isDefined(queued);

    const edit = orchestrator.dispatch({
      type: "queued-run.edit",
      commandId: CommandId.make("edit"),
      threadId,
      runId: queued.id,
      text: "My own words",
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(edit)));
    const message = (yield* projections.getThreadProjection(threadId)).messages.find(
      (candidate) => candidate.id === MessageId.make("send-queued"),
    );
    assert.equal(message?.context?.guest?.text, "Why?");
  }).pipe(Effect.provide(layerTest)),
);

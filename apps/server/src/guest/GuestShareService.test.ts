import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EventId,
  GuestShareId,
  type GuestStreamEvent,
  MessageId,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as GuestShareService from "./GuestShareService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for guest shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guest-share-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

// The Connect hostname the fake tunnel reports. Tests set it to null to simulate an unlink.
const hostname = Ref.makeUnsafe<string | null>("env.t3.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(hostname), (value) => ({
    readyConnections: 1,
    hostname: value,
    protocol: "http2",
  })),
});
const layerProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([]),
});
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-guest-share-" });
// The real cleanup also closes terminals and previews; these tests only need the files gone.
const layerCleanup = Layer.effect(
  ResourceCleanupService.ResourceCleanupService,
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      cleanupScheduledTasks: () => Effect.void,
      cleanupTerminals: () => Effect.void,
      cleanupPreviews: () => Effect.void,
      cleanupAttachments: (attachmentIds) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
            return path === null ? Effect.void : fileSystem.remove(path).pipe(Effect.orDie);
          },
          { discard: true },
        ),
    };
  }),
).pipe(Layer.provide(layerConfig), Layer.provide(NodeServices.layer));
class RecordedAnalytics extends Context.Service<
  RecordedAnalytics,
  Ref.Ref<ReadonlyArray<Readonly<Record<string, unknown>>>>
>()("t3/guest/GuestShareService.test/RecordedAnalytics") {}
const layerAnalytics = Layer.effectContext(
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<Readonly<Record<string, unknown>>>>([]);
    return Context.make(RecordedAnalytics, recorded).pipe(
      Context.add(
        AnalyticsService.AnalyticsService,
        AnalyticsService.AnalyticsService.of({
          record: (event, properties) =>
            Ref.update(recorded, (events) => [...events, { event, ...properties }]),
          flush: Effect.void,
          recordOwners: () => Effect.void,
        }),
      ),
    );
  }),
);
const layerTest = GuestShareService.layer.pipe(
  Layer.provideMerge(
    CommandOutputHub.layer.pipe(
      Layer.provideMerge(layerOrchestration.pipe(Layer.provide(layerCleanup))),
    ),
  ),
  Layer.provide(layerProviders),
  Layer.provideMerge(ServerSettings.layerTest({ guestSharingEnabled: true })),
  Layer.provide(layerConnect),
  Layer.provideMerge(layerAnalytics),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(layerConfig),
  Layer.provideMerge(NodeServices.layer),
);

const threadId = ThreadId.make("thread:guest-share-service");

const shareThreadFor = Effect.fn(function* (threadId: ThreadId) {
  yield* Ref.set(hostname, "env.t3.test");
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:guest-share-service"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const guestShares = yield* GuestShareService.GuestShareService;
  const { url } = yield* guestShares.create({ threadId });
  assert.isTrue(url.startsWith("https://env.t3.test/guest#"));
  const credential = url.slice(url.indexOf("#") + 1);
  return { orchestrator, guestShares, credential };
});
const shareThread = shareThreadFor(threadId);

it.effect("spends an invite once and ends the guest stream when the owner stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const again = yield* Effect.exit(guestShares.redeem({ credential, name: "Eve" }));
    assert.isTrue(Exit.isFailure(again));
    // The browser that joined can come back without the spent invite.
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(guestShares.check(session))));
    // An invite token is not a session token.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(credential))));

    const events = yield* guestShares.stream(session);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-guest-share"),
      threadId,
    });
    const received = Array.from(yield* Stream.runCollect(events));
    assert.deepEqual(
      received.map((event) => (event.type === "thread" ? event.item.kind : event.type)),
      ["view", "snapshot", "ended"],
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(session))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.check(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("counts a guest joining and sending, without their name or text", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session, shareId } = yield* guestShares.redeem({ credential, name: "Sam" });
    yield* guestShares.submit(session, { shareId, text: "Hello" }, []);
    assert.deepEqual(yield* Ref.get(yield* RecordedAnalytics), [
      { event: "feature.used", feature: "guest_share.join" },
      { event: "feature.used", feature: "guest_message.submit", variant: "text_only" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("streams the owner's thread events after the share and a snapshot", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const events = yield* guestShares.stream(session);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-message"),
      threadId,
      messageId: MessageId.make("message:owner"),
      text: "Fix the login bug",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-after-message"),
      threadId,
    });
    const received = Array.from(yield* Stream.runCollect(events));
    assert.equal(received.at(-1)?.type, "ended");
    const turnItems = received.flatMap((event) =>
      event.type === "thread" &&
      event.item.kind === "event" &&
      event.item.event.type === "turn-item.updated"
        ? [event.item.event.payload]
        : [],
    );
    assert.deepEqual(
      turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
      ["Fix the login bug"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("starts a stream with the runs and items already in the thread", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-message-before"),
      threadId,
      messageId: MessageId.make("message:before"),
      text: "Fix the login bug",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const [view, snapshot] = Array.from(
      yield* Stream.runCollect(Stream.take(yield* guestShares.stream(session), 2)),
    );
    assert.equal(view?.type, "view");
    if (snapshot?.type !== "thread" || snapshot.item.kind !== "snapshot") {
      return assert.fail("Expected the thread snapshot second.");
    }
    assert.equal(snapshot.item.projection.runs.length, 1);
    assert.include(
      snapshot.item.projection.visibleTurnItems.map((row) => row.item.type),
      "user_message",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("redeems only a short invite whose signature and share id are both current", () =>
  Effect.gen(function* () {
    const { guestShares, credential: replaced } = yield* shareThread;
    const { url } = yield* guestShares.create({ threadId });
    const credential = url.slice(url.indexOf("#") + 1);
    assert.match(credential, /^[\w-]{22}\.[\w-]{22}$/);

    const [shareId, signature] = credential.split(".");
    const tampered = `${shareId}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
    for (const rejected of [tampered, replaced]) {
      const error = yield* Effect.flip(guestShares.redeem({ credential: rejected, name: "Eve" }));
      assert.equal(error.reason, "invalid");
    }
    assert.isTrue(
      Exit.isSuccess(yield* Effect.exit(guestShares.redeem({ credential, name: "Sam" }))),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses guest requests once T3 Connect no longer serves the link's host", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const { id: shareId } = (yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.getThreadRecords(threadId, []),
    )).thread.guestShare!;
    yield* Ref.set(hostname, null);
    const submitted = yield* Effect.exit(
      guestShares.submit(session, { shareId, text: "Hello" }, []),
    );
    assert.isTrue(Exit.isFailure(submitted));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("closes an open guest stream when T3 Connect stops serving the link's host", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );
    yield* Ref.set(hostname, null);
    yield* TestClock.adjust("30 seconds");
    // No `ended`: the browser reconnects, and the host check refuses it while Connect is gone.
    const received = Array.from(yield* Fiber.join(collecting));
    assert.deepEqual(
      received.map((event) => (event.type === "thread" ? event.item.kind : event.type)),
      ["view", "snapshot"],
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(session))));
    yield* Ref.set(hostname, "env.t3.test");
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(guestShares.stream(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses new links and every guest request while the beta is off", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ guestSharingEnabled: false });
    // An open stream closes at the next access check.
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(collecting);
    assert.equal((yield* Effect.flip(guestShares.create({ threadId }))).reason, "disabled");
    assert.equal((yield* Effect.flip(guestShares.check(session))).reason, "inactive");
    // Turning it back on lets the same guest back in.
    yield* settings.updateSettings({ guestSharingEnabled: true });
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(guestShares.check(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends an open guest stream when the link expires", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("25 hours");
    const received = Array.from(yield* Fiber.join(collecting));
    assert.equal(received.at(-1)?.type, "ended");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("shows the guest the thread's new model", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const events = yield* guestShares.stream(session);
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("switch-model"),
      threadId,
      modelSelection: { instanceId, model: "gpt-5.2-codex" },
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-after-switch"),
      threadId,
    });
    const views = Array.from(yield* Stream.runCollect(events)).flatMap((event) =>
      event.type === "view" ? [event.view.model.name] : [],
    );
    assert.include(views, "gpt-5.2-codex");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a message a page sends for a share the cookie no longer opens", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const submitted = yield* Effect.exit(
      guestShares.submit(session, { shareId: GuestShareId.make("share:older"), text: "Hello" }, []),
    );
    assert.isTrue(Exit.isFailure(submitted));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("serves no render for an item outside the shared thread", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.render(session, "item:missing"))));
    // The invite itself is not a session.
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(guestShares.render(credential, "item:missing"))),
    );
  }).pipe(Effect.provide(layerTest)),
);

const ownerRun = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("owner-message-for-command"),
    threadId,
    messageId: MessageId.make("message:command"),
    text: "Build it",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const { runs } = (yield* orchestrator.getThreadSnapshotWindow(threadId, { rowLimit: 10 }))
    .projection;
  return runs[0]!.id;
});

const writeItem = (
  id: string,
  fields:
    | Pick<
        Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
        "type" | "status" | "input" | "output"
      >
    | Pick<
        Extract<OrchestrationV2TurnItem, { type: "file_change" }>,
        "type" | "status" | "fileName" | "diffStr" | "oldStr" | "newStr"
      >,
) =>
  Effect.gen(function* () {
    const runId = yield* ownerRun;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            title: null,
            startedAt: now,
            completedAt: fields.status === "running" ? null : now,
            updatedAt: now,
            ...fields,
          },
        },
      ],
    });
    return TurnItemId.make(id);
  });

it.effect("gives the guest a command's detail and output, but no file diffs", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const command = yield* writeItem("item:command", {
      type: "command_execution",
      status: "completed",
      input: "ls /work/src",
      output: "/work/src/auth.ts\n",
    });

    const detail = (yield* guestShares.item(session, command)).item;
    assert.deepInclude(detail, { input: "ls /work/src", output: "/work/src/auth.ts\n" });
    const edit = yield* writeItem("item:edit", {
      type: "file_change",
      status: "completed",
      fileName: "src/auth.ts",
      diffStr: "-const token = 1;\n+const token = 2;\n",
    });
    const write = yield* writeItem("item:write", {
      type: "file_change",
      status: "completed",
      fileName: "src/config.ts",
      oldStr: "",
      newStr: "export const key = 1;\n",
    });
    for (const [id, fileName] of [
      [edit, "src/auth.ts"],
      [write, "src/config.ts"],
    ] as const) {
      const change = (yield* guestShares.item(session, id)).item;
      assert.deepInclude(change, { type: "file_change", fileName });
      assert.doesNotHaveAnyKeys(change, ["diffStr", "oldStr", "newStr", "diffOmitted"]);
    }
    const frames = Array.from(
      yield* Stream.runCollect(yield* guestShares.commandOutput(session, command)),
    );
    assert.deepEqual(frames, [
      { kind: "replace", text: "/work/src/auth.ts\n", truncated: false, running: false },
    ]);
    // Only with a session, and only for an item of this thread.
    const refused: ReadonlyArray<Effect.Effect<unknown, GuestShareService.GuestShareAccessError>> =
      [
        guestShares.item(credential, command),
        guestShares.commandOutput(credential, command),
        guestShares.item(session, "item:elsewhere"),
      ];
    for (const request of refused) {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(request)));
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("streams file changes to guests without a diff to fetch", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    yield* writeItem("item:before", {
      type: "file_change",
      status: "completed",
      fileName: "src/auth.ts",
      diffStr: "-const token = 1;\n+const token = 2;\n",
    });
    const events = yield* guestShares.stream(session);
    yield* writeItem("item:after", {
      type: "file_change",
      status: "completed",
      fileName: "src/config.ts",
      oldStr: "",
      newStr: "export const key = 1;\n",
    });
    yield* writeItem("item:failed", {
      type: "file_change",
      status: "failed",
      fileName: "src/missing.ts",
      diffStr: "String to replace not found",
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-after-file-changes"),
      threadId,
    });
    const received = Array.from(yield* Stream.runCollect(events));
    const fileChanges = received.flatMap((event) =>
      event.type !== "thread"
        ? []
        : event.item.kind === "snapshot"
          ? event.item.projection.visibleTurnItems.map((row) => row.item)
          : event.item.kind === "event" && event.item.event.type === "turn-item.updated"
            ? [event.item.event.payload]
            : [],
    );
    const byId = new Map(
      fileChanges.flatMap((item) => (item.type === "file_change" ? [[item.id, item]] : [])),
    );
    // The owner's wire marks these diffOmitted; a guest's row must not offer to fetch them.
    for (const id of ["item:before", "item:after"]) {
      const change = byId.get(TurnItemId.make(id));
      assert.isDefined(change);
      assert.doesNotHaveAnyKeys(change, ["diffOmitted", "diffStr", "oldStr", "newStr"]);
    }
    assert.deepInclude(byId.get(TurnItemId.make("item:failed")), {
      diffStr: "String to replace not found",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pages the guest back through turns older than the stream's snapshot", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const runId = yield* ownerRun;
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const shot = `${directory}/old.png`;
    yield* fileSystem.writeFile(shot, PNG);
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const base = { threadId, runId, nodeId: null, providerThreadId: null, providerTurnId: null };
    const turnItem = (id: string, ordinal: number, payload: object) => ({
      id: EventId.make(`event:${id}`),
      type: "turn-item.updated" as const,
      threadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        ...base,
        id: TurnItemId.make(id),
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        title: null,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        messageId: MessageId.make(id),
        ...payload,
      } as OrchestrationV2TurnItem,
    });
    yield* eventSink.write({
      events: [
        turnItem("item:old-image", 1, {
          type: "assistant_message",
          text: `![Old](${shot})`,
          streaming: false,
        }),
        ...Array.from({ length: 30 }, (_, index) =>
          turnItem(`item:ask-${index}`, index + 2, {
            type: "user_message",
            text: `Ask ${index}`,
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            attachments: [],
          }),
        ),
      ],
    });

    const [, opening] = Array.from(
      yield* Stream.runCollect(Stream.take(yield* guestShares.stream(session), 2)),
    );
    if (opening?.type !== "thread" || opening.item.kind !== "snapshot") {
      return assert.fail("Expected the thread snapshot second.");
    }
    const ids = (rows: ReadonlyArray<{ readonly sourceItemId: string }>) =>
      rows.map((row) => row.sourceItemId);
    assert.notInclude(ids(opening.item.projection.visibleTurnItems), "item:old-image");
    let cursor = opening.item.historyCursor ?? null;
    assert.isNotNull(cursor);
    // The page has not shown the old reply yet, so its image does not load.
    assert.equal((yield* Effect.flip(guestShares.media(session, shot))).reason, "unavailable");
    // Only a session pages.
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.history(credential, cursor!))));

    const older: Array<string> = [];
    while (cursor !== null) {
      const page: OrchestrationV2ThreadHistoryPage = yield* guestShares.history(session, cursor);
      older.push(...ids(page.items));
      cursor = page.hasMoreHistory ? page.nextCursor : null;
    }
    assert.include(older, "item:old-image");
    assert.deepStrictEqual(yield* guestShares.media(session, shot), {
      path: shot,
      mimeType: "image/png",
    });
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("ends a running command's output once the owner stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const command = yield* writeItem("item:running", {
      type: "command_execution",
      status: "running",
      input: "ls /work/src",
    });
    const collecting = yield* Stream.runCollect(
      yield* guestShares.commandOutput(session, command),
    ).pipe(Effect.forkChild);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-during-command"),
      threadId,
    });
    yield* TestClock.adjust("30 seconds");
    const frames = Array.from(yield* Fiber.join(collecting));
    assert.isTrue(frames.every((frame) => frame.running));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.commandOutput(session, command))));
  }).pipe(Effect.provide(layerTest)),
);

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const MIB = 1024 * 1024;

/** Files as the multipart parser leaves them: on disk, with the browser's name and type. */
const uploadsOf = Effect.fn(function* (
  files: ReadonlyArray<{
    readonly name: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped();
  return yield* Effect.forEach(files, (file, index) => {
    const path = `${directory}/${index}`;
    return fileSystem
      .writeFile(path, file.bytes)
      .pipe(Effect.as({ name: file.name, contentType: file.contentType, path }));
  });
});
const png = (name: string, sizeBytes = PNG.length) => {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set(PNG);
  return { name, contentType: "image/png", bytes };
};

/** Every stored attachment file. */
const storedFiles = Effect.gen(function* () {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readDirectory(attachmentsDir).pipe(Effect.orElseSucceed(() => []));
});

const joinedGuest = Effect.gen(function* () {
  const shared = yield* shareThread;
  const { token: session, shareId } = yield* shared.guestShares.redeem({
    credential: shared.credential,
    name: "Sam",
  });
  return { ...shared, session, shareId };
});

const waitingMessages = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
  return thread.guestShare?.messages ?? [];
});

it.effect("refuses too many files, too many bytes, and images that are not what they say", () =>
  Effect.gen(function* () {
    const { guestShares, session, shareId } = yield* joinedGuest;
    const before = yield* storedFiles;
    const refused = [
      ["too_many_files", [1, 2, 3, 4, 5].map((index) => png(`${index}.png`))],
      ["too_large", [png("big.png", 10 * MIB + 1)]],
      ["unsupported_file", [{ name: "logo.svg", contentType: "image/svg+xml", bytes: PNG }]],
      [
        "unsupported_file",
        [{ name: "page.png", contentType: "image/png", bytes: new TextEncoder().encode("<html>") }],
      ],
      [
        "unsupported_file",
        [{ name: "empty.txt", contentType: "text/plain", bytes: new Uint8Array() }],
      ],
    ] as const;
    for (const [reason, files] of refused) {
      const error = yield* Effect.flip(
        guestShares.submit(session, { shareId, text: "Look" }, yield* uploadsOf(files)),
      );
      assert.equal(error.reason, reason);
    }
    // Nothing is kept from a refused message, and no message waits.
    assert.deepEqual(yield* storedFiles, before);
    assert.deepEqual(yield* waitingMessages, []);

    yield* guestShares.submit(
      session,
      { shareId, text: "" },
      yield* uploadsOf([
        png("screen.png"),
        // A direction override would make this name read as a PDF.
        {
          name: "notes\u202Efdp.html",
          contentType: "text/html",
          bytes: new TextEncoder().encode("<b>"),
        },
      ]),
    );
    const [message] = yield* waitingMessages;
    assert.deepEqual(
      message?.attachments?.map(({ type, name, mimeType, sizeBytes }) => ({
        type,
        name,
        mimeType,
        sizeBytes,
      })),
      [
        { type: "image", name: "screen.png", mimeType: "image/png", sizeBytes: PNG.length },
        { type: "file", name: "notes_fdp.html", mimeType: "text/html", sizeBytes: 3 },
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("caps the bytes of files waiting in one share", () =>
  Effect.gen(function* () {
    const { guestShares, session, shareId } = yield* joinedGuest;
    const submit = (sizeBytes: number) =>
      Effect.gen(function* () {
        return guestShares.submit(
          session,
          { shareId, text: "Look" },
          yield* uploadsOf([png("big.png", sizeBytes)]),
        );
      }).pipe(Effect.flatten);
    yield* submit(9 * MIB);
    yield* submit(9 * MIB);
    const error = yield* Effect.flip(submit(9 * MIB));
    assert.equal(error.reason, "files_busy");
    // Text alone still goes through.
    yield* guestShares.submit(session, { shareId, text: "One more thing" }, []);
    assert.equal((yield* waitingMessages).length, 3);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("deletes a waiting message's files when the owner dismisses it or stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* guestShares.submit(
      session,
      { shareId, text: "First" },
      yield* uploadsOf([png("a.png")]),
    );
    yield* guestShares.submit(
      session,
      { shareId, text: "Second" },
      yield* uploadsOf([png("b.png")]),
    );
    const [first, second] = yield* waitingMessages;
    const fileOf = (message: typeof first) => message!.attachments![0]!.id;
    const stored = yield* storedFiles;
    assert.isTrue(stored.some((entry) => entry.startsWith(fileOf(first))));

    yield* orchestrator.dispatch({
      type: "thread.guest-message.dismiss",
      commandId: CommandId.make("dismiss-first"),
      threadId,
      guestMessageId: first!.id,
    });
    yield* worker.drain();
    const afterDismiss = yield* storedFiles;
    assert.isFalse(afterDismiss.some((entry) => entry.startsWith(fileOf(first))));
    assert.isTrue(afterDismiss.some((entry) => entry.startsWith(fileOf(second))));
    // A dismissed message's file is no longer the guest's to load.
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(guestShares.attachment(session, fileOf(first)))),
    );

    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-with-files"),
      threadId,
    });
    yield* worker.drain();
    assert.isFalse((yield* storedFiles).some((entry) => entry.startsWith(fileOf(second))));
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each(["thread.archive", "thread.delete"] as const)(
  "deletes a waiting message's files on %s",
  (type) =>
    Effect.gen(function* () {
      const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const before = yield* storedFiles;
      yield* guestShares.submit(
        session,
        { shareId, text: "Look" },
        yield* uploadsOf([png("a.png")]),
      );
      assert.equal((yield* storedFiles).length, before.length + 1);
      yield* orchestrator.dispatch({
        type,
        commandId: CommandId.make(`${type}-with-files`),
        threadId,
      });
      yield* worker.drain();
      assert.deepEqual(yield* storedFiles, before);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("sends a guest's files as the guest's message and keeps them the guest's to load", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
    yield* guestShares.submit(
      session,
      { shareId, text: "See this" },
      yield* uploadsOf([png("a.png")]),
    );
    const [message] = yield* waitingMessages;
    const pending = message!.attachments!;
    // Served while it waits.
    const served = yield* guestShares.attachment(session, pending[0]!.id);
    assert.equal(served.attachment.mimeType, "image/png");

    // The day-old pending-upload sweep leaves a waiting guest's files alone.
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    // Any pending upload counts as stale at the end of time.
    sweepStalePendingAttachments({ attachmentsDir, nowMs: Number.MAX_SAFE_INTEGER });
    const copied = pending[0]!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send-guest-files"),
      threadId,
      messageId: MessageId.make("message:guest-files"),
      guestMessageId: message!.id,
      text: "",
      attachments: [copied],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const items = (yield* orchestrator.getThreadSnapshotWindow(threadId, {
      rowLimit: 20,
    })).projection.visibleTurnItems.map((entry) => entry.item);
    const sent = items.find(
      (item) => item.type === "user_message" && item.context?.guest?.guestMessageId === message!.id,
    );
    assert.deepInclude(sent, { attachments: [copied] });
    if (sent?.type !== "user_message") return;
    assert.deepEqual(sent.context?.guest, {
      guestMessageId: message!.id,
      name: "Sam",
      text: "See this",
      shareId,
    });
    // The guest loads the thread's copy from their own row.
    const fromRow = yield* guestShares.attachment(session, copied.id);
    assert.equal(fromRow.attachment.id, copied.id);

    // Still theirs after their share's message list has trimmed it away.
    for (let index = 0; index < 21; index += 1) {
      yield* guestShares.submit(session, { shareId, text: `note ${index}` }, []);
      const [waiting] = (yield* waitingMessages).filter((next) => next.status === "pending");
      yield* orchestrator.dispatch({
        type: "thread.guest-message.dismiss",
        commandId: CommandId.make(`dismiss-note-${index}`),
        threadId,
        guestMessageId: waiting!.id,
      });
    }
    assert.isFalse((yield* waitingMessages).some((next) => next.id === message!.id));
    assert.equal((yield* guestShares.attachment(session, copied.id)).attachment.id, copied.id);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("serves the shared thread's files to its guest, never another thread's", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, session, shareId } = yield* joinedGuest;
    // Another thread's guest attaches a file.
    const other = yield* shareThreadFor(ThreadId.make("thread:other-share"));
    const otherGuest = yield* guestShares.redeem({ credential: other.credential, name: "Eve" });
    yield* guestShares.submit(
      otherGuest.token,
      { shareId: otherGuest.shareId, text: "Mine" },
      yield* uploadsOf([png("eve.png")]),
    );
    const { thread: otherThread } = yield* orchestrator.getThreadRecords(
      ThreadId.make("thread:other-share"),
      [],
    );
    const othersFile = otherThread.guestShare!.messages[0]!.attachments![0]!.id;
    assert.isTrue(
      Exit.isSuccess(yield* Effect.exit(guestShares.attachment(otherGuest.token, othersFile))),
    );

    // The owner sends a message with an image of their own.
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const ownerImage = {
      type: "image" as const,
      id: ChatAttachmentId.make(createAttachmentId(threadId)!),
      name: "secret.png",
      mimeType: "image/png",
      sizeBytes: PNG.length,
    };
    yield* fileSystem.writeFile(
      resolveAttachmentPath({ attachmentsDir, attachment: ownerImage })!,
      PNG,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("owner-image"),
      threadId,
      messageId: MessageId.make("message:owner-image"),
      text: "My screen",
      attachments: [ownerImage],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    // The guest sees the thread as the owner does, files included.
    assert.equal(
      (yield* guestShares.attachment(session, ownerImage.id)).attachment.id,
      ownerImage.id,
    );
    for (const id of [othersFile, "pending-missing"]) {
      const error = yield* Effect.flip(guestShares.attachment(session, id));
      assert.equal(error.reason, "unavailable");
    }
    // Nor with the other share's id on this page.
    assert.equal(
      (yield* Effect.flip(
        guestShares.submit(session, { shareId: otherGuest.shareId, text: "x" }, []),
      )).reason,
      "stale_page",
    );
    assert.isDefined(shareId);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("serves an image on the host only when an agent reply the guest sees shows it", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares } = yield* shareThread;
    const runId = yield* ownerRun;
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const shot = `${directory}/my shot.png`;
    const fileUrl = `${directory}/file-url.png`;
    const page = `${directory}/page.png`;
    const fromUser = `${directory}/from-user.png`;
    const unnamed = `${directory}/unnamed.png`;
    const later = `${directory}/later.png`;
    for (const path of [shot, fileUrl, fromUser, unnamed, later]) {
      yield* fileSystem.writeFile(path, PNG);
    }
    yield* fileSystem.writeFileString(page, "<script>alert(1)</script>");
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0];
    const item = (
      id: string,
      ordinal: number,
      fields:
        | { readonly type: "assistant_message"; readonly text: string }
        | { readonly type: "user_message"; readonly text: string },
      target: { readonly threadId: ThreadId; readonly runId: RunId } = { threadId, runId },
    ) => ({
      id: EventId.make(`event:${id}`),
      type: "turn-item.updated" as const,
      threadId: target.threadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(id),
        threadId: target.threadId,
        runId: target.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        title: null,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        messageId: MessageId.make(id),
        ...(fields.type === "assistant_message"
          ? { ...fields, streaming: false }
          : {
              ...fields,
              createdBy: "user" as const,
              creationSource: "web" as const,
              inputIntent: "turn_start" as const,
              attachments: [],
            }),
      },
    });
    yield* eventSink.write({
      events: [
        item("item:agent-images", 1, {
          type: "assistant_message",
          text: `Done: ![Shot](<${shot}>) ![Other](file://${encodeURI(fileUrl)}) ![Page](${page})`,
        }),
        // A guest's sent message is a user message; it must not open files on the host.
        item("item:guest-image", 2, { type: "user_message", text: `![Mine](${fromUser})` }),
        {
          id: EventId.make("event:run-done"),
          type: "run.updated" as const,
          threadId,
          runId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run!, status: "completed" as const, completedAt: now },
        },
      ],
    });
    // The guest watches a fork, which shows these replies as inherited history.
    const forkId = ThreadId.make("thread:guest-share-fork");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork"),
      sourceThreadId: threadId,
      targetThreadId: forkId,
      sourcePoint: { type: "run", runId },
      createdBy: "user",
      creationSource: "web",
    });
    const { url } = yield* guestShares.create({ threadId: forkId });
    const { token: session } = yield* guestShares.redeem({
      credential: url.slice(url.indexOf("#") + 1),
      name: "Sam",
    });

    // The guest's page opens, and its stream sends the replies the fork inherits.
    const sent = yield* Queue.unbounded<GuestStreamEvent>();
    yield* Stream.runForEach(yield* guestShares.stream(session), (event) =>
      Queue.offer(sent, event),
    ).pipe(Effect.forkScoped);
    const sentItem = Effect.fn(function* (id: string) {
      for (;;) {
        const event = yield* Queue.take(sent);
        if (
          event.type === "thread" &&
          event.item.kind === "event" &&
          event.item.event.type === "turn-item.updated" &&
          event.item.event.payload.id === id
        ) {
          return;
        }
      }
    });

    // The agent shows another screenshot live, then enough rows to push the first reply out of
    // the window, before the page asks for any image.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("fork-message"),
      threadId: forkId,
      messageId: MessageId.make("message:fork"),
      text: "One more",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    const forkRun = (yield* orchestrator.getThreadRecords(forkId, ["runs"])).runs.at(-1)!;
    const inFork = { threadId: forkId, runId: forkRun.id };
    yield* eventSink.write({
      events: [
        item(
          "item:later-image",
          1,
          { type: "assistant_message", text: `![Later](${later})` },
          inFork,
        ),
        ...Array.from({ length: 600 }, (_, index) =>
          item(
            `item:filler-${index}`,
            index + 2,
            { type: "assistant_message", text: "Working." },
            inFork,
          ),
        ),
      ],
    });
    yield* sentItem("item:later-image");

    // The page still shows every reply it was sent, so each image loads.
    for (const path of [shot, fileUrl, later]) {
      assert.deepStrictEqual(yield* guestShares.media(session, path), {
        path,
        mimeType: "image/png",
      });
    }
    for (const path of [page, fromUser, unnamed, `${directory}/missing.png`]) {
      assert.equal((yield* Effect.flip(guestShares.media(session, path))).reason, "unavailable");
    }

    // A reply edited to drop its image stops allowing it.
    yield* eventSink.write({
      events: [
        {
          ...item("item:later-image", 1, { type: "assistant_message", text: "Gone." }, inFork),
          id: EventId.make("event:later-image-edited"),
        },
      ],
    });
    yield* sentItem("item:later-image");
    assert.equal((yield* Effect.flip(guestShares.media(session, later))).reason, "unavailable");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("keeps a connected guest's images while other shares come and go", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const shot = `${directory}/shot.png`;
    yield* fileSystem.writeFile(shot, PNG);
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    /** A shared thread whose agent reply shows the screenshot, and its guest's session. */
    const sharedWithImage = Effect.fn(function* (id: ThreadId) {
      const { orchestrator, guestShares, credential } = yield* shareThreadFor(id);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`message:${id}`),
        threadId: id,
        messageId: MessageId.make(`message:${id}`),
        text: "Show me",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const runId = (yield* orchestrator.getThreadRecords(id, ["runs"])).runs[0]!.id;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:reply:${id}`),
            type: "turn-item.updated",
            threadId: id,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:reply:${id}`),
              threadId: id,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              title: null,
              status: "completed",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`item:reply:${id}`),
              text: `![Shot](${shot})`,
              streaming: false,
            },
          },
        ],
      });
      const { token } = yield* guestShares.redeem({ credential, name: "Sam" });
      return { guestShares, token };
    });

    // This guest's page stays open while more guests than the record keeps open and close theirs.
    const { guestShares, token } = yield* sharedWithImage(threadId);
    const opened = yield* Deferred.make<void>();
    yield* Stream.runForEach(yield* guestShares.stream(token), () =>
      Deferred.succeed(opened, undefined),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(opened);
    const closedTokens: Array<string> = [];
    for (let index = 0; index < 65; index++) {
      const other = yield* sharedWithImage(ThreadId.make(`thread:other-${index}`));
      const events = yield* guestShares.stream(other.token);
      // The first is built but never read, as for a HEAD request; the rest open and close.
      if (index > 0) yield* Stream.runDrain(Stream.take(events, 2));
      closedTokens.push(other.token);
    }
    assert.equal((yield* guestShares.media(token, shot)).mimeType, "image/png");
    // Records of guests with no open page were dropped to make room.
    for (const closed of closedTokens.slice(0, 2)) {
      assert.equal((yield* Effect.flip(guestShares.media(closed, shot))).reason, "unavailable");
    }

    // A new link on the thread starts empty: its guest gets nothing the last guest was sent.
    const { url } = yield* guestShares.create({ threadId });
    const next = yield* guestShares.redeem({
      credential: url.slice(url.indexOf("#") + 1),
      name: "Kim",
    });
    assert.equal((yield* Effect.flip(guestShares.media(next.token, shot))).reason, "unavailable");
    yield* Stream.runDrain(Stream.take(yield* guestShares.stream(next.token), 2));
    assert.equal((yield* guestShares.media(next.token, shot)).mimeType, "image/png");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

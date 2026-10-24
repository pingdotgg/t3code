import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GuestShareId,
  MessageId,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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
const layerTest = GuestShareService.layer.pipe(
  Layer.provideMerge(CommandOutputHub.layer.pipe(Layer.provideMerge(layerOrchestration))),
  Layer.provide(layerProviders),
  Layer.provide(ProjectStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provide(layerConnect),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-guest-share-" })),
  Layer.provide(NodeServices.layer),
);

const threadId = ThreadId.make("thread:guest-share-service");
const WORKTREE = "/work/guest-share-service";

const shareThread = Effect.gen(function* () {
  yield* Ref.set(hostname, "env.t3.test");
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-guest-share-service"),
    threadId,
    projectId: ProjectId.make("project:guest-share-service"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: WORKTREE,
    createdBy: "user",
    creationSource: "web",
  });
  const guestShares = yield* GuestShareService.GuestShareService;
  const { url } = yield* guestShares.create({ threadId });
  assert.isTrue(url.startsWith("https://env.t3.test/guest#"));
  const credential = url.slice(url.indexOf("#") + 1);
  return { orchestrator, guestShares, credential };
});

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
      received.map((event) => event.type),
      ["snapshot", "ended"],
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.stream(session))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.check(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("streams the runs and items the guest can see, then the same state on reconnect", () =>
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
    assert.equal(received[0]?.type, "snapshot");
    assert.equal(received.at(-1)?.type, "ended");
    // The run's updates in one batch arrive as one event.
    assert.equal(received.filter((event) => event.type === "run").length, 1);
    const message = received.flatMap((event) =>
      event.type === "item" && event.item.type === "user_message" ? [event.item] : [],
    );
    assert.deepEqual(
      message.map((item) => [item.text, item.title, item.attachments]),
      [["Fix the login bug", null, []]],
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
    const [snapshot] = Array.from(
      yield* Stream.runCollect(Stream.take(yield* guestShares.stream(session), 1)),
    );
    assert.equal(snapshot?.type, "snapshot");
    if (snapshot?.type !== "snapshot") return;
    assert.equal(snapshot.runs.length, 1);
    assert.include(
      snapshot.items.map((item) => item.type),
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
    const submitted = yield* Effect.exit(guestShares.submit(session, { shareId, text: "Hello" }));
    assert.isTrue(Exit.isFailure(submitted));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends an open guest stream when T3 Connect stops serving the link's host", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );
    yield* Ref.set(hostname, null);
    yield* TestClock.adjust("30 seconds");
    const received = Array.from(yield* Fiber.join(collecting));
    assert.deepEqual(
      received.map((event) => event.type),
      ["snapshot", "ended"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a message a page sends for a share the cookie no longer opens", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const submitted = yield* Effect.exit(
      guestShares.submit(session, { shareId: GuestShareId.make("share:older"), text: "Hello" }),
    );
    assert.isTrue(Exit.isFailure(submitted));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("serves no render for an item the guest's transcript does not show", () =>
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

/** A message from the owner, which opens the run the guest's window starts at. */
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

const writeCommand = (
  runId: RunId | null,
  id: string,
  fields: Pick<
    Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
    "status" | "output"
  >,
) =>
  Effect.gen(function* () {
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
            type: "command_execution",
            input: `ls ${WORKTREE}/src`,
            ...fields,
          },
        },
      ],
    });
    return TurnItemId.make(id);
  });

it.effect("gives the guest a visible command's output with paths rewritten, and nothing else", () =>
  Effect.gen(function* () {
    const { guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const runId = yield* ownerRun;
    const output = `${WORKTREE}/src/auth.ts\n`;
    const command = yield* writeCommand(runId, "item:command", { status: "completed", output });
    const outsideRun = yield* writeCommand(null, "item:no-run", { status: "completed", output });

    const detail = yield* guestShares.item(session, command);
    assert.deepInclude(detail, { input: "ls src", output: "src/auth.ts\n", outputOmitted: true });
    const frames = Array.from(
      yield* Stream.runCollect(yield* guestShares.commandOutput(session, command)),
    );
    assert.deepEqual(frames, [
      { kind: "replace", text: "src/auth.ts\n", truncated: false, running: false },
    ]);

    const denied: ReadonlyArray<Effect.Effect<unknown, GuestShareService.GuestShareAccessError>> = [
      guestShares.item(session, outsideRun),
      guestShares.commandOutput(session, outsideRun),
      guestShares.item(credential, command),
      guestShares.commandOutput(credential, command),
    ];
    for (const request of denied) {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(request)));
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends a running command's output when the owner stops sharing", () =>
  Effect.gen(function* () {
    const { orchestrator, guestShares, credential } = yield* shareThread;
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const runId = yield* ownerRun;
    const command = yield* writeCommand(runId, "item:running", { status: "running" });
    const collecting = yield* Stream.runCollect(
      yield* guestShares.commandOutput(session, command),
    ).pipe(Effect.forkChild);
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-during-command"),
      threadId,
    });
    const frames = Array.from(yield* Fiber.join(collecting));
    assert.isTrue(frames.every((frame) => frame.running));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(guestShares.commandOutput(session, command))));
  }).pipe(Effect.provide(layerTest)),
);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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

// The Connect hostname the fake tunnel reports. Tests set it to null to simulate an unlink.
// The real cleanup also closes terminals and previews; these tests only need the files gone.
















/** Files as the multipart parser leaves them: on disk, with the browser's name and type. */
/** Every stored attachment file. */









import { instanceId, adapter, layerDatabase, layerOrchestration, hostname, layerConnect, layerProviders, layerConfig, layerCleanup, RecordedAnalytics, layerAnalytics, layerTest, threadId, shareThreadFor, ownerRun, writeItem, PNG, MIB, uploadsOf, png, storedFiles, joinedGuest, waitingMessages, shareThread } from "./GuestShareService-fixtures.testkit.ts";

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
      assert.doesNotHaveAnyKeys(change, ["diffStr", "oldStr", "newStr"]);
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

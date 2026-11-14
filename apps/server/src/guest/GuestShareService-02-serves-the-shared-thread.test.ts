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
it.effect("gives a fork's guest the files on messages the fork shows from its source", () =>
  Effect.gen(function* () {
    const { orchestrator } = yield* shareThread;
    const guestShares = yield* GuestShareService.GuestShareService;
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const ownerImage = Effect.fn(function* (name: string) {
      const image = {
        type: "image" as const,
        id: ChatAttachmentId.make(createAttachmentId(threadId)!),
        name,
        mimeType: "image/png",
        sizeBytes: PNG.length,
      };
      yield* fileSystem.writeFile(
        resolveAttachmentPath({ attachmentsDir, attachment: image })!,
        PNG,
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`owner:${name}`),
        threadId,
        messageId: MessageId.make(`message:${name}`),
        text: name,
        attachments: [image],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      return image;
    });
    const inherited = yield* ownerImage("before.png");
    const run = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make("event:run-done"),
          type: "run.updated",
          threadId,
          runId: run.id,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    const forkId = ThreadId.make("thread:guest-share-fork");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork"),
      sourceThreadId: threadId,
      targetThreadId: forkId,
      sourcePoint: { type: "run", runId: run.id },
      createdBy: "user",
      creationSource: "web",
    });
    const later = yield* ownerImage("after.png");
    const { url } = yield* guestShares.create({ threadId: forkId });
    const { token: session } = yield* guestShares.redeem({
      credential: url.slice(url.indexOf("#") + 1),
      name: "Sam",
    });

    assert.equal(
      (yield* guestShares.attachment(session, inherited.id)).attachment.id,
      inherited.id,
    );
    // The source's messages after the fork point are not part of the fork.
    assert.equal(
      (yield* Effect.flip(guestShares.attachment(session, later.id))).reason,
      "unavailable",
    );
  }).pipe(Effect.provide(layerTest)),
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

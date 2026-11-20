import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  EnvironmentId,
  EventId,
  type OrchestrationV2StoredEvent,
  OrchestrationV2ThreadStreamItem,
  type PeerLinkThreadReadError,
  PEER_LINK_THREAD_HISTORY_ROUTE,
  PEER_LINK_THREAD_ITEM_ROUTE,
  PEER_LINK_THREAD_STREAM_ROUTE,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { TestClock } from "effect/testing";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinkThreadHttp from "./linkThreadHttp.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as PeerThreadRelay from "./PeerThreadRelay.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box", { linkThreadStream: true });
const boxThread = ThreadId.make("thread:box");
const boxItem = TurnItemId.make("item:box");
const input = { environmentId: box.environmentId, threadId: boxThread };

const boxShell = { ...liveThreadShell(boxThread, { activeRunId: null }), title: "On the box" };
const boxProjection = idleThreadProjection(boxShell);

const archived = (sequence: number): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event:${sequence}`),
    type: "thread.archived",
    threadId: boxThread,
    occurredAt: DateTime.makeUnsafe(0),
    payload: boxProjection.thread,
  },
});

/**
 * B, serving one thread to its links: `live` feeds the thread's live events, and `closed`
 * completes when B's stream of them is torn down.
 */
const serveBox = Effect.gen(function* () {
  const live = yield* Queue.unbounded<OrchestrationV2StoredEvent, Cause.Done>();
  const closed = yield* Deferred.make<void>();
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(threadId === boxThread ? boxShell : null),
    ensureLegacyTranscript: () => Effect.void,
    getThreadSnapshotWindow: () =>
      Effect.succeed({ snapshotSequence: 7, projection: boxProjection } as never),
    streamStoredEventsFrom: () =>
      Stream.fromQueue(live).pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
    getThreadHistoryPage: (_threadId, cursor) =>
      Effect.succeed({ snapshotSequence: 7, items: [], hasMoreHistory: false, nextCursor: cursor }),
    getTurnItem: () => Effect.succeed({ item: null }),
  });
  const peer = yield* servePeer(box, Layer.empty, LinkThreadHttp.layer).pipe(
    Effect.provide(
      Layer.merge(threads, Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({})),
    ),
  );
  return { ...peer, live, closed };
});

/** A, holding the link and relaying B's threads to its own clients. */
const makeLaptop = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const answered = yield* Queue.unbounded<number>();
  const relay = yield* PeerThreadRelay.layer.pipe(
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(
      Layer.effect(
        HttpClient.HttpClient,
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.tap((response) => Queue.offer(answered, response.status)),
        ),
      ).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
    Layer.build,
  );
  return {
    links: Context.get(linking, PeerLinks.PeerLinks),
    settings: Context.get(linking, ServerSettings.ServerSettingsService),
    relay: Context.get(relay, PeerThreadRelay.PeerThreadRelay),
    /** The status of each answer the relay got, once its headers arrived. */
    answered,
  };
});

const encodeStreamItem = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadStreamItem)),
);

it.effect("relays a linked thread's snapshot and live items, and stops when the client does", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b, "read-only");

      const received = yield* Queue.unbounded<unknown>();
      const subscription = yield* a.relay.subscribe(input).pipe(
        Stream.runForEach((item) => Queue.offer(received, item)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(received)).toMatchObject({
        kind: "snapshot",
        snapshotSequence: 7,
        projection: { thread: { id: boxThread, title: "On the box" } },
      });
      yield* Queue.offer(b.live, archived(8));
      expect(yield* Queue.take(received)).toMatchObject({
        kind: "event",
        sequence: 8,
        event: { type: "thread.archived", threadId: boxThread },
      });

      // The client unsubscribing ends B's stream, not only A's relay of it.
      yield* Fiber.interrupt(subscription);
      yield* Deferred.await(b.closed);

      expect(yield* a.relay.historyPage({ ...input, cursor: "cursor-1" })).toMatchObject({
        hasMoreHistory: false,
        nextCursor: "cursor-1",
      });
      expect(yield* a.relay.item({ ...input, itemId: boxItem })).toEqual({ item: null });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("tells the client when the linked environment closes the stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b);
      const ended = yield* a.relay
        .subscribe(input)
        .pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);
      yield* Queue.end(b.live);
      expect(yield* Fiber.join(ended)).toMatchObject({ reason: "unreachable", label: "Box" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("serves a thread only to a link's own session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b);
      const linkBearer = `Bearer ${(yield* a.links.resolve(box.environmentId)).token}`;
      const agent = yield* b.auth.issueMcpClientSession({
        label: "ChatGPT",
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      const http = yield* HttpClient.HttpClient;
      const statusOf = (headers: Record<string, string>) =>
        http
          .execute(
            HttpClientRequest.get(
              `${b.url}${PEER_LINK_THREAD_STREAM_ROUTE}?thread=${encodeURIComponent(boxThread)}`,
            ).pipe(HttpClientRequest.setHeaders(headers)),
          )
          .pipe(Effect.map((response) => response.status));

      expect(yield* statusOf({})).toBe(401);
      // An outside agent's session reads through `/mcp`, never here.
      expect(yield* statusOf({ authorization: `Bearer ${agent.token}` })).toBe(403);
      // A browser page never holds a link's token, so no page's request is served.
      expect(yield* statusOf({ authorization: linkBearer, origin: "https://app.t3.codes" })).toBe(
        403,
      );
      yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      expect(yield* statusOf({ authorization: linkBearer })).toBe(403);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);

it.effect("tells a client why a linked environment's thread cannot be read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveBox;
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b);
      const session = (yield* b.linkedSessions)[0]!.sessionId;
      const reasonOf = (target: Partial<typeof input> = {}) =>
        a.relay.subscribe({ ...input, ...target }).pipe(
          Stream.runHead,
          Effect.flip,
          Effect.map(({ reason, label }: PeerLinkThreadReadError) => ({ reason, label })),
        );

      expect(yield* reasonOf({ threadId: ThreadId.make("thread:box-gone") })).toEqual({
        reason: "thread_not_found",
        label: "Box",
      });

      yield* Ref.set(b.bearers, []);
      expect(
        yield* reasonOf({ environmentId: EnvironmentId.make("environment-elsewhere") }),
      ).toEqual({ reason: "unknown_link", label: null });
      yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      expect(yield* reasonOf()).toEqual({ reason: "disabled", label: null });
      yield* a.settings.updateSettings({ linkedEnvironmentsEnabled: true });
      // A box from before it served threads to links is never asked for one.
      yield* Ref.set(b.descriptor, descriptorOf("environment-box", "Box"));
      expect(yield* reasonOf()).toEqual({ reason: "incompatible", label: "Box" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
      yield* Ref.set(b.descriptor, box);

      yield* b.auth.revokeSession(session);
      expect(yield* reasonOf()).toEqual({ reason: "rejected", label: "Box" });

      yield* Ref.set(b.bearers, []);
      yield* TestClock.adjust(Duration.days(31));
      expect(yield* reasonOf()).toEqual({ reason: "expired", label: "Box" });
      expect(yield* Ref.get(b.bearers)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("leaves out what a newer linked environment sends that this one cannot pass on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const frames = [
        encodeStreamItem({ kind: "snapshot", snapshotSequence: 7, projection: boxProjection }),
        // An event type added after this version, which its schema reads but never writes.
        JSON.stringify({ kind: "event", sequence: 8, event: { type: "thread.teleported" } }),
        encodeStreamItem({ kind: "event", ...archived(9) }),
      ];
      const b = yield* servePeer(
        box,
        Layer.empty,
        HttpRouter.add(
          "GET",
          PEER_LINK_THREAD_STREAM_ROUTE,
          Effect.succeed(
            HttpServerResponse.stream(
              Stream.fromIterable(frames).pipe(
                Stream.map((frame) => `data: ${frame}\n\n`),
                Stream.concat(Stream.never),
                Stream.encodeText,
              ),
              { contentType: "text/event-stream" },
            ),
          ),
        ),
      );
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b);

      const relayed = yield* a.relay.subscribe(input).pipe(Stream.take(2), Stream.runCollect);
      expect(relayed.map((item) => [item.kind, "sequence" in item ? item.sequence : null])).toEqual(
        [
          ["snapshot", null],
          ["event", 9],
        ],
      );
      // Each one goes on to this environment's client in the same encoding.
      expect(relayed.map((item) => encodeStreamItem(item))).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("gives up on an answer whose body never arrives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const stalled = (status: number) =>
        Effect.succeed(
          HttpServerResponse.stream(
            Stream.make("{").pipe(Stream.concat(Stream.never), Stream.encodeText),
            { status, contentType: "application/json" },
          ),
        );
      const b = yield* servePeer(
        box,
        Layer.empty,
        Layer.mergeAll(
          HttpRouter.add("GET", PEER_LINK_THREAD_ITEM_ROUTE, stalled(200)),
          HttpRouter.add("GET", PEER_LINK_THREAD_HISTORY_ROUTE, stalled(403)),
        ),
      );
      const a = yield* makeLaptop;
      yield* linkTo(a.links, b);

      const item = yield* a.relay
        .item({ ...input, itemId: boxItem })
        .pipe(Effect.flip, Effect.forkScoped);
      expect(yield* Queue.take(a.answered)).toBe(200);
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* Fiber.join(item)).toMatchObject({ reason: "unreachable", label: "Box" });

      // A refusal is known by its status, so its body is not waited for either.
      const page = yield* a.relay
        .historyPage({ ...input, cursor: "cursor-1" })
        .pipe(Effect.flip, Effect.forkScoped);
      expect(yield* Queue.take(a.answered)).toBe(403);
      yield* TestClock.adjust(Duration.seconds(10));
      expect(yield* Fiber.join(page)).toMatchObject({ reason: "rejected", label: "Box" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

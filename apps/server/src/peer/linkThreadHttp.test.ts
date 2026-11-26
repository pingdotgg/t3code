import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PEER_LINK_THREAD_STREAM_ROUTE,
  ThreadId,
  type OrchestrationV2StoredEvent,
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
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinkThreadHttp from "./linkThreadHttp.ts";

const threadId = ThreadId.make("thread:stream-revocation");
const threadShell = { ...liveThreadShell(threadId, { activeRunId: null }), title: "Streamed" };
const threadProjection = idleThreadProjection(threadShell);

const serveLinkThread = Effect.gen(function* () {
  const live = yield* Queue.unbounded<OrchestrationV2StoredEvent, Cause.Done>();
  const closed = yield* Deferred.make<void>();
  const base = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-thread-http-" }),
    ManagedPolicy.layerTest(),
    Sqlite.layerMemory,
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const storage = ServerSecretStore.layer.pipe(Layer.provideMerge(base));
  const settingsLayer = ServerSettings.layer.pipe(Layer.provideMerge(storage));
  const authContext = yield* Layer.build(
    EnvironmentAuth.layer.pipe(
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(settingsLayer),
      Layer.fresh,
    ),
  );
  const settings = Context.get(authContext, ServerSettings.ServerSettingsService);
  yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });

  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(id === threadId ? threadShell : null),
    ensureLegacyTranscript: () => Effect.void,
    getThreadSnapshotWindow: () =>
      Effect.succeed({ snapshotSequence: 1, projection: threadProjection } as never),
    streamStoredEventsFrom: () =>
      Stream.fromQueue(live).pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
    getThreadHistoryPage: (_id, cursor) =>
      Effect.succeed({ snapshotSequence: 1, items: [], hasMoreHistory: false, nextCursor: cursor }),
    getTurnItem: () => Effect.succeed({ item: null }),
  });

  yield* HttpRouter.serve(LinkThreadHttp.layer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeedContext(authContext),
        threads,
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
      ),
    ),
    Layer.fresh,
    Layer.build,
  );

  const address = (yield* HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
  const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
  const sessions = Context.get(authContext, SessionStore.SessionStore);
  const session = yield* auth.issueMcpClientSession({
    label: "T3 Code · Laptop",
    access: "auto",
    peerLink: true,
    client: { deviceType: "bot" },
  });

  const http = yield* HttpClient.HttpClient;
  const openStream = Effect.gen(function* () {
    const chunks = yield* Queue.unbounded<string>();
    const ended = yield* Deferred.make<void>();
    const fiber = yield* HttpClient.withScope(http)
      .execute(
        HttpClientRequest.get(
          `http://127.0.0.1:${address.port}${PEER_LINK_THREAD_STREAM_ROUTE}?thread=${encodeURIComponent(threadId)}`,
        ).pipe(HttpClientRequest.setHeaders({ authorization: `Bearer ${session.token}` })),
      )
      .pipe(
        Effect.flatMap((response) => {
          expect(response.status).toBe(200);
          return response.stream.pipe(
            Stream.decodeText,
            Stream.runForEach((chunk) => Queue.offer(chunks, chunk)),
          );
        }),
        Effect.ensuring(Deferred.succeed(ended, undefined)),
        Effect.scoped,
        Effect.forkScoped,
      );
    let firstEvent = "";
    while (!firstEvent.includes('"kind":"snapshot"')) {
      firstEvent += yield* Queue.take(chunks);
    }
    expect(firstEvent).toContain('"kind":"snapshot"');
    return { ended, fiber };
  });

  return { auth, sessions, settings, session, closed, openStream };
});

it.effect("terminates an open SSE stream immediately when the peer link session is revoked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* serveLinkThread;
      const stream = yield* server.openStream;

      yield* server.sessions.revoke(server.session.sessionId);
      yield* Deferred.await(server.closed);
      yield* Deferred.await(stream.ended);
      yield* Fiber.join(stream.fiber);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);

it.effect(
  "terminates an open SSE stream immediately when linkedEnvironmentsEnabled is turned off",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveLinkThread;
        const stream = yield* server.openStream;

        yield* server.settings.updateSettings({ linkedEnvironmentsEnabled: false });
        yield* Deferred.await(server.closed);
        yield* Deferred.await(stream.ended);
        yield* Fiber.join(stream.fiber);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);

it.effect(
  "does not renew the peer link session TTL while an SSE stream stays open and ends at expiry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveLinkThread;
        const initialExpiry = DateTime.toEpochMillis(server.session.expiresAt);
        const stream = yield* server.openStream;

        // Past the 1-day renewal step and old 30s recheck interval: TTL must remain unchanged.
        yield* TestClock.adjust(Duration.days(2));
        const active = (yield* server.auth.listSessions()).find(
          (candidate) => candidate.sessionId === server.session.sessionId,
        );
        expect(active === undefined ? undefined : DateTime.toEpochMillis(active.expiresAt)).toBe(
          initialExpiry,
        );
        expect(Option.isNone(yield* Deferred.poll(server.closed))).toBe(true);

        // Reaching the original expiry closes the stream without needing another request.
        yield* TestClock.adjust(Duration.days(28));
        yield* Deferred.await(server.closed);
        yield* Deferred.await(stream.ended);
        yield* Fiber.join(stream.fiber);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  SpeechStreamEvent,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
} from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { SpeechService, type SpeechStream } from "./SpeechService.ts";
import { runSpeechSocket, speechStreamRouteLayer } from "./stream.ts";
import type * as NetAddress from "effect/net/NetAddress";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechStreamEvent));

function client(url: string) {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () =>
    socket.send(JSON.stringify({ type: "start", options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS })),
  );
  const events: SpeechStreamEvent[] = [];
  let waiter: ReturnType<typeof Promise.withResolvers<SpeechStreamEvent>> | undefined;
  socket.addEventListener("message", ({ data }) => {
    const event = decodeEvent(data);
    if (waiter) {
      waiter.resolve(event);
      waiter = undefined;
    } else events.push(event);
  });
  socket.addEventListener("error", () => waiter?.reject(new Error("Speech socket failed.")));
  socket.addEventListener("close", () => waiter?.reject(new Error("Speech socket closed.")));
  return {
    socket,
    next: () => {
      const event = events.shift();
      if (event) return Promise.resolve(event);
      waiter = Promise.withResolvers<SpeechStreamEvent>();
      return waiter.promise;
    },
  };
}

const withServer = Effect.fn("test.speech.withServer")(function* (
  startStream: SpeechService["Service"]["startStream"],
  run: (url: string) => Promise<void>,
) {
  const routes = HttpRouter.add(
    "GET",
    "/ws/voice",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      yield* runSpeechSocket(socket, { startStream }).pipe(Effect.scoped);
      return HttpServerResponse.empty();
    }),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const server = yield* HttpServer.HttpServer;
  const address = server.address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  const url = `ws://${host}:${address.port}/ws/voice`;
  yield* Effect.promise(() => run(url));
});

it.live("acknowledges binary audio and returns the finalized transcript over a real socket", () => {
  const closed = Promise.withResolvers<void>();
  const received: number[] = [];
  const stream: SpeechStream = {
    feed: (bytes) =>
      Effect.sync(() => {
        received.push(
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true),
        );
        return { revision: received.length, text: { committed: "hello ", tentative: "world" } };
      }),
    finish: Effect.sync(() => {
      expect(received).toEqual([0.25, 0.5]);
      return "hello world";
    }),
  };
  return withServer(
    () => Effect.acquireRelease(Effect.succeed(stream), () => Effect.sync(() => closed.resolve())),
    async (url) => {
      const connection = client(url);
      try {
        expect(await connection.next()).toEqual({ type: "ready" });
        for (const value of [0.25, 0.5]) {
          connection.socket.send(new Float32Array([value]));
          expect(await connection.next()).toMatchObject({
            type: "update",
            text: { tentative: "world" },
          });
        }
        connection.socket.send(JSON.stringify({ type: "finish" }));
        expect(await connection.next()).toEqual({ type: "finished", text: "hello world" });
        await closed.promise;
      } finally {
        connection.socket.close();
      }
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("releases in-flight inference after disconnect", () => {
  const feeding = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const stream: SpeechStream = {
    feed: () => Effect.sync(() => feeding.resolve()).pipe(Effect.andThen(Effect.never)),
    finish: Effect.succeed("unexpected"),
  };
  return withServer(
    () => Effect.acquireRelease(Effect.succeed(stream), () => Effect.sync(() => closed.resolve())),
    async (url) => {
      const connection = client(url);
      try {
        await connection.next();
        connection.socket.send(new Float32Array([0.25]));
        await feeding.promise;
        connection.socket.close();
        await closed.promise;
      } finally {
        connection.socket.close();
      }
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("processes pipelined audio before the finish command", () => {
  const firstFeed = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const received: number[] = [];
  const stream: SpeechStream = {
    feed: (bytes) =>
      Effect.promise(async () => {
        const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(
          0,
          true,
        );
        received.push(value);
        if (received.length === 1) {
          firstFeed.resolve();
          await releaseFirst.promise;
        }
        return { revision: received.length, text: null };
      }),
    finish: Effect.sync(() => {
      expect(received).toEqual([0.25, 0.5]);
      return "done";
    }),
  };
  return withServer(
    () => Effect.succeed(stream),
    async (url) => {
      const connection = client(url);
      try {
        expect(await connection.next()).toEqual({ type: "ready" });
        connection.socket.send(new Float32Array([0.25]));
        await firstFeed.promise;
        connection.socket.send(new Float32Array([0.5]));
        connection.socket.send(JSON.stringify({ type: "finish" }));
        releaseFirst.resolve();
        expect(await connection.next()).toMatchObject({ type: "update", revision: 1 });
        expect(await connection.next()).toMatchObject({ type: "update", revision: 2 });
        expect(await connection.next()).toEqual({ type: "finished", text: "done" });
      } finally {
        connection.socket.close();
      }
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("stops in-flight work, closes the socket, and releases the stream on invalidation", () => {
  const feeding = Promise.withResolvers<void>();
  const released = Promise.withResolvers<boolean>();
  let feedInterrupted = false;
  const sessionId = AuthSessionId.make("speech-test");
  const stream: SpeechStream = {
    feed: () =>
      Effect.sync(() => feeding.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => (feedInterrupted = true))),
      ),
    finish: Effect.never,
  };
  return Effect.gen(function* () {
    const invalidated = yield* Deferred.make<void>();
    yield* Layer.build(
      HttpRouter.serve(speechStreamRouteLayer, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId,
                subject: "speech-test",
                method: "bearer-access-token",
                scopes: [AuthOrchestrationOperateScope],
                proofKeyThumbprint: "thumbprint",
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(SessionStore.SessionStore, {
            cookieName: "test",
            legacyCookieName: undefined,
            awaitInvalidation: (id, proofKeyThumbprint) =>
              id === sessionId && proofKeyThumbprint === "thumbprint"
                ? Deferred.await(invalidated)
                : Effect.never,
          }),
        ),
        Layer.provide(
          Layer.mock(SpeechService, {
            startStream: () =>
              Effect.acquireRelease(Effect.succeed(stream), () =>
                Effect.sync(() => released.resolve(feedInterrupted)),
              ),
          }),
        ),
      ),
    );
    const server = yield* HttpServer.HttpServer;
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const connection = client(`${origin}/ws/voice`);
    yield* Effect.addFinalizer(() => Effect.sync(() => connection.socket.close()));
    const closed = new Promise<void>((resolve) =>
      connection.socket.addEventListener("close", () => resolve(), { once: true }),
    );
    expect(yield* Effect.promise(() => connection.next())).toEqual({ type: "ready" });
    connection.socket.send(new Float32Array([0.25]));
    yield* Effect.promise(() => feeding.promise);
    yield* Deferred.succeed(invalidated, undefined);
    const [, interruptedBeforeRelease] = yield* Effect.promise(() =>
      Promise.all([closed, released.promise]),
    );
    expect(interruptedBeforeRelease).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.effect("releases the stream when a started client goes silent", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let pulls = 0;
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Effect.suspend(() =>
          pulls++ === 0
            ? Effect.succeed([
                JSON.stringify({ type: "start", options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS }),
              ] as const)
            : Effect.never,
        ),
        upgrade: () => Effect.void,
      }),
      writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
    });
    const stream: SpeechStream = { feed: () => Effect.never, finish: Effect.never };
    yield* runSpeechSocket(socket, {
      startStream: () =>
        Effect.acquireRelease(Effect.succeed(stream), () => Deferred.succeed(released, undefined)),
    }).pipe(Effect.scoped, Effect.forkChild);

    yield* TestClock.adjust("1 minute");
    expect(yield* Deferred.isDone(released)).toBe(true);
  }),
);

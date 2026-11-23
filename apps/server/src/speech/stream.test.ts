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
  CloudSpeechError,
  SpeechStreamEvent,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
} from "@t3tools/contracts";
import type { CloudSpeech } from "./CloudSpeech.ts";
import type { SpeechService, SpeechStream } from "./SpeechService.ts";
import { runSpeechSocket } from "./stream.ts";
import type * as NetAddress from "effect/net/NetAddress";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechStreamEvent));

function client(url: string, start: object = {}) {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () =>
    socket.send(
      JSON.stringify({ type: "start", options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, ...start }),
    ),
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
  startCloudStream: CloudSpeech["Service"]["startStream"] = () => Effect.die("unexpected cloud"),
) {
  const routes = HttpRouter.add(
    "GET",
    "/ws/voice",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      yield* runSpeechSocket(socket, { startStream }, { startStream: startCloudStream }).pipe(
        Effect.scoped,
      );
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
    yield* runSpeechSocket(
      socket,
      {
        startStream: () =>
          Effect.acquireRelease(Effect.succeed(stream), () =>
            Deferred.succeed(released, undefined),
          ),
      },
      { startStream: () => Effect.die("unexpected cloud") },
    ).pipe(Effect.scoped, Effect.forkChild);

    yield* TestClock.adjust("1 minute");
    expect(yield* Deferred.isDone(released)).toBe(true);
  }),
);

it.live("sends a cloud start to that provider's live stream and reports its error", () => {
  const started: string[] = [];
  return withServer(
    () => Effect.die("unexpected local stream"),
    async (url) => {
      const live = client(url, { cloudProvider: "xai" });
      try {
        expect(await live.next()).toEqual({ type: "ready" });
        live.socket.send(new Float32Array([0.25]));
        expect(await live.next()).toEqual({
          type: "update",
          revision: 1,
          text: { committed: "hello", tentative: "" },
        });
        live.socket.send(JSON.stringify({ type: "finish" }));
        expect(await live.next()).toEqual({ type: "finished", text: "hello" });
      } finally {
        live.socket.close();
      }
      const refused = client(url, { cloudProvider: "xai" });
      try {
        expect(await refused.next()).toEqual({
          type: "error",
          message: new CloudSpeechError({ provider: "xai", reason: "missing-key" }).message,
        });
      } finally {
        refused.socket.close();
      }
    },
    (provider) =>
      Effect.suspend(() => {
        started.push(provider);
        return started.length > 1
          ? Effect.fail(new CloudSpeechError({ provider, reason: "missing-key" }))
          : Effect.succeed({
              feed: () =>
                Effect.succeed({ revision: 1, text: { committed: "hello", tentative: "" } }),
              finish: Effect.succeed("hello"),
            });
      }),
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { SpeechStreamEvent } from "@t3tools/contracts";
import type { SpeechService, SpeechStream } from "./SpeechService.ts";
import { runSpeechSocket } from "./stream.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechStreamEvent));

function client(url: string) {
  const socket = new WebSocket(url);
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
  if (server.address._tag !== "TcpAddress") throw new Error("Expected a TCP server.");
  const url = `ws://127.0.0.1:${server.address.port}/ws/voice`;
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
    Effect.acquireRelease(Effect.succeed(stream), () => Effect.sync(() => closed.resolve())),
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

it.live.each(["disconnect", "overlapping audio"] as const)(
  "releases in-flight inference after %s",
  (action) => {
    const feeding = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const stream: SpeechStream = {
      feed: () => Effect.sync(() => feeding.resolve()).pipe(Effect.andThen(Effect.never)),
      finish: Effect.succeed("unexpected"),
    };
    return withServer(
      Effect.acquireRelease(Effect.succeed(stream), () => Effect.sync(() => closed.resolve())),
      async (url) => {
        const connection = client(url);
        try {
          await connection.next();
          connection.socket.send(new Float32Array([0.25]));
          await feeding.promise;
          if (action === "disconnect") connection.socket.close();
          else {
            connection.socket.send(new Float32Array([0.5]));
            expect(await connection.next()).toMatchObject({ type: "error" });
          }
          await closed.promise;
        } finally {
          connection.socket.close();
        }
      },
    ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
  },
);

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  decodeSpeechAudioFrame,
  VoiceConversationEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";

import { runVoiceCallSocket } from "./callSocket.ts";
import type * as VoiceConversationService from "./VoiceConversationService.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceConversationEvent));

type Received = VoiceConversationEvent | { type: "audio"; seq: number; pcm: number[] };

function client(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const opened = new Promise((resolve) => socket.addEventListener("open", resolve));
  const events: Received[] = [];
  const closed = Promise.withResolvers<number>();
  let waiter: ReturnType<typeof Promise.withResolvers<Received>> | undefined;
  socket.addEventListener("message", ({ data }) => {
    let event: Received;
    if (data instanceof ArrayBuffer) {
      const frame = decodeSpeechAudioFrame(new Uint8Array(data));
      event = { type: "audio", seq: frame.seq, pcm: [...frame.pcm] };
    } else event = decodeEvent(data);
    if (waiter) {
      waiter.resolve(event);
      waiter = undefined;
    } else events.push(event);
  });
  socket.addEventListener("close", ({ code }) => {
    closed.resolve(code);
    waiter?.reject(new Error("Voice call socket closed."));
  });
  return {
    socket,
    opened,
    closed: closed.promise,
    command: (command: object) => socket.send(JSON.stringify(command)),
    next: () => {
      const event = events.shift();
      if (event) return Promise.resolve(event);
      waiter = Promise.withResolvers<Received>();
      return waiter.promise;
    },
  };
}

/** A call that echoes each mic frame back as a caption and one frame of voice audio. */
const fakeCalls = Effect.fn("test.callSocket.fakeCalls")(function* () {
  const released = yield* Deferred.make<void>();
  const idle = yield* Deferred.make<"idle">();
  const log: string[] = [];
  const calls: VoiceConversationService.VoiceConversationService["Service"] = {
    start: ({ threadId, options, send }) =>
      Effect.gen(function* () {
        log.push(`start ${threadId} ${options.voice}`);
        yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
        yield* send({ type: "ready" });
        return {
          hear: (pcm) =>
            Effect.gen(function* () {
              const samples = pcm.byteLength / 4;
              log.push(`hear ${samples}`);
              if (samples === 2) return yield* Deferred.succeed(idle, "idle");
              yield* send({ type: "caption", who: "you", committed: "hi", tentative: "" });
              yield* send({ type: "audio", seq: 1, pcm: Float32Array.of(0.5) });
            }),
          played: (seq, sample) => Effect.sync(() => void log.push(`played ${seq} ${sample}`)),
          mute: Effect.sync(() => void log.push("mute")),
          unmute: Effect.sync(() => void log.push("unmute")),
          ended: Deferred.await(idle),
        };
      }),
  };
  return { calls, released, log };
});

const withServer = Effect.fn("test.callSocket.withServer")(function* (
  calls: VoiceConversationService.VoiceConversationService["Service"],
  run: (url: string) => Promise<void>,
) {
  const routes = HttpRouter.add(
    "GET",
    "/ws/voice/conversation",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      yield* runVoiceCallSocket(socket, calls).pipe(Effect.scoped);
      return HttpServerResponse.empty();
    }),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const server = yield* HttpServer.HttpServer;
  const address = server.address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  yield* Effect.promise(() => run(`ws://${host}:${address.port}/ws/voice/conversation`));
});

const start = {
  type: "start",
  threadId: "thread:voice",
  options: {
    transcription: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    voice: "bm_george",
    source: "web",
  },
};

it.live("runs a call over the socket and frees it when the client hangs up", () =>
  Effect.gen(function* () {
    const fake = yield* fakeCalls();
    yield* withServer(fake.calls, async (url) => {
      const connection = client(url);
      await connection.opened;
      connection.command(start);
      expect(await connection.next()).toEqual({ type: "ready" });
      connection.socket.send(new Float32Array([0.25]));
      expect(await connection.next()).toEqual({
        type: "caption",
        who: "you",
        committed: "hi",
        tentative: "",
      });
      expect(await connection.next()).toEqual({ type: "audio", seq: 1, pcm: [0.5] });
      connection.command({ type: "played", seq: 1, sample: 1 });
      connection.command({ type: "mute" });
      connection.command({ type: "unmute" });
      connection.socket.close();
      await connection.closed;
    });
    yield* Deferred.await(fake.released);
    expect(fake.log).toEqual([
      "start thread:voice bm_george",
      "hear 1",
      "played 1 1",
      "mute",
      "unmute",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("closes with 1000 when the call idles out", () =>
  Effect.gen(function* () {
    const idle = yield* fakeCalls();
    yield* withServer(idle.calls, async (url) => {
      const connection = client(url);
      await connection.opened;
      connection.command(start);
      expect(await connection.next()).toEqual({ type: "ready" });
      connection.socket.send(new Float32Array([0, 0]));
      expect(await connection.closed).toBe(1000);
    });
    yield* Deferred.await(idle.released);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("closes with 1000 when the client stops the call", () =>
  Effect.gen(function* () {
    const stopped = yield* fakeCalls();
    yield* withServer(stopped.calls, async (url) => {
      const connection = client(url);
      await connection.opened;
      connection.command(start);
      expect(await connection.next()).toEqual({ type: "ready" });
      connection.command({ type: "stop" });
      expect(await connection.closed).toBe(1000);
    });
    yield* Deferred.await(stopped.released);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("rejects audio or commands before the call starts", () =>
  Effect.gen(function* () {
    const fake = yield* fakeCalls();
    yield* withServer(fake.calls, async (url) => {
      const early = client(url);
      await early.opened;
      early.socket.send(new Float32Array([0]));
      expect(await early.next()).toEqual({
        type: "error",
        message: "Start the voice call before sending audio.",
      });
      expect(await early.closed).toBe(1008);
      const invalid = client(url);
      await invalid.opened;
      invalid.command({ type: "start", threadId: "thread:voice", options: {} });
      expect(await invalid.next()).toMatchObject({ type: "error" });
      expect(await invalid.closed).toBe(1008);
    });
    expect(fake.log).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

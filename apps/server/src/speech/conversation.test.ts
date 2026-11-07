import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Stream from "effect/Stream";
import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SpeechConversationEvent,
  decodeSpeechAudioFrame,
} from "@t3tools/contracts";
import type * as NetAddress from "effect/net/NetAddress";
import type { SpeechStream, SpeechStreamUpdate } from "./SpeechService.ts";
import type * as TextToSpeech from "./TextToSpeech.ts";
import { runConversationSocket, type VoiceDownlink } from "./conversation.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechConversationEvent));

type Received = SpeechConversationEvent | { type: "audio"; seq: number; pcm: number[] };

function client(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () =>
    socket.send(JSON.stringify({ type: "start", options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS })),
  );
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
    waiter?.reject(new Error("Conversation socket closed."));
  });
  return {
    socket,
    closed: closed.promise,
    next: () => {
      const event = events.shift();
      if (event) return Promise.resolve(event);
      waiter = Promise.withResolvers<Received>();
      return waiter.promise;
    },
  };
}

const withServer = Effect.fn("test.conversation.withServer")(function* (
  stream: SpeechStream,
  idleSamples: number,
  run: (url: string) => Promise<void>,
  respond?: (utterance: string, voice: VoiceDownlink) => Effect.Effect<void>,
) {
  const routes = HttpRouter.add(
    "GET",
    "/ws/voice/conversation",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      yield* runConversationSocket(
        socket,
        {
          startStream: (_options, mode) =>
            mode === "conversation" ? Effect.succeed(stream) : Effect.die("dictation"),
        },
        tts,
        { idleSamples, ...(respond ? { respond } : {}) },
      ).pipe(Effect.scoped);
      return HttpServerResponse.empty();
    }),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const server = yield* HttpServer.HttpServer;
  const address = server.address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  yield* Effect.promise(() => run(`ws://${host}:${address.port}/ws/voice/conversation`));
});

// Each word becomes one sample holding its length; "stall" never finishes rendering.
const tts: TextToSpeech.TextToSpeech["Service"] = {
  sampleRate: 24_000,
  synthesize: (text) =>
    text === "stall"
      ? Stream.never
      : Stream.fromIterable(text.split(" ").map((word) => Float32Array.of(word.length))),
};

const scripted = (updates: readonly Omit<SpeechStreamUpdate, "revision">[], utterance: string) => {
  let fed = 0;
  let nexts = 0;
  const stream: SpeechStream = {
    feed: () => Effect.sync(() => ({ revision: ++fed, ...updates[fed - 1]! })),
    finish: Effect.die("unused"),
    next: Effect.sync(() => {
      nexts += 1;
      return utterance;
    }),
  };
  return { stream, nexts: () => nexts };
};

const say = (samples: number, voicedUntil: number | undefined, words: string | null) => ({
  samples,
  ...(voicedUntil === undefined ? {} : { voicedUntil }),
  text: words === null ? null : { committed: words, tentative: "" },
});

it.live("splits continuous audio into utterances at the pause the words call for", () => {
  const script = scripted(
    [
      say(8000, 8000, "Run the tests."),
      say(16000, 8000, null),
      say(24000, 8000, null),
      say(8000, 4000, "And"),
    ],
    "Run the tests.",
  );
  return withServer(script.stream, 1_000_000, async (url) => {
    const connection = client(url);
    try {
      expect(await connection.next()).toEqual({ type: "ready" });
      for (let chunk = 0; chunk < 4; chunk++) connection.socket.send(new Float32Array([0.25]));
      const events: Received[] = [];
      for (let count = 0; count < 7; count++) events.push(await connection.next());
      expect(events.map((event) => event.type)).toEqual([
        "update",
        "speech-start",
        "update",
        "update",
        "utterance",
        "update",
        "speech-start",
      ]);
      expect(events[4]).toEqual({ type: "utterance", text: "Run the tests." });
      expect(script.nexts()).toBe(1);
    } finally {
      connection.socket.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("closes after the idle limit of audio without speech", () => {
  const script = scripted([say(1, undefined, ""), say(2, undefined, "")], "");
  return withServer(script.stream, 2, async (url) => {
    const connection = client(url);
    try {
      expect(await connection.next()).toEqual({ type: "ready" });
      connection.socket.send(new Float32Array([0]));
      expect(await connection.next()).toMatchObject({ type: "update", revision: 1 });
      connection.socket.send(new Float32Array([0]));
      expect(await connection.next()).toMatchObject({ type: "update", revision: 2 });
      expect(await connection.next()).toEqual({ type: "idle" });
      expect(await connection.closed).toBe(1000);
      expect(script.nexts()).toBe(0);
    } finally {
      connection.socket.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("speaks replies as framed audio and cuts what is still playing", () => {
  const script = scripted([say(8000, 8000, "Hi."), say(24000, 8000, null)], "Hi.");
  return withServer(
    script.stream,
    1_000_000,
    async (url) => {
      const connection = client(url);
      try {
        expect(await connection.next()).toEqual({ type: "ready" });
        for (let chunk = 0; chunk < 2; chunk++) connection.socket.send(new Float32Array([0.25]));
        const events: Received[] = [];
        while (events.at(-1)?.type !== "audio") events.push(await connection.next());
        expect(events.filter((event) => event.type !== "update")).toEqual([
          { type: "speech-start" },
          { type: "utterance", text: "Hi." },
          { type: "speak", seq: 1, text: "stall", sampleRate: 24_000 },
          { type: "cut", seq: 1 },
          { type: "speak", seq: 2, text: "Hello there", sampleRate: 24_000 },
          { type: "audio", seq: 2, pcm: [5] },
        ]);
        expect(await connection.next()).toEqual({ type: "audio", seq: 2, pcm: [5] });
      } finally {
        connection.socket.close();
      }
    },
    (utterance, voice) =>
      Effect.gen(function* () {
        expect(utterance).toBe("Hi.");
        yield* voice.speak("stall");
        yield* voice.cut;
        yield* voice.speak("Hello there");
      }).pipe(Effect.orDie),
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

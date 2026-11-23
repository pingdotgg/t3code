import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

it.effect.each(["openai", "xai"] as const)("sends only to %s using its own saved key", (provider) =>
  Effect.gen(function* () {
    const reference = {
      provider: SecretProviderId.make("work"),
      reference: "op://Work/Voice/key",
    };
    let resolved: string | undefined;
    let cached: string | undefined;
    const read = vi.fn(() => Effect.sync(() => [(cached ??= resolved)]));
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ text: "hello" }));
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeSocket.layerWebSocketConstructor),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(
            Layer.mock(SecretResolver.SecretResolver)({
              read,
              label: () => Effect.succeed("Work"),
              invalidate: () =>
                Effect.sync(() => {
                  cached = undefined;
                }),
            }),
          ),
        ),
      ),
    );
    // A full dictionary plus a hint still stays within xAI's 100-term limit.
    const words = Array.from({ length: 99 }, (_, index) => `word${index}`);
    const transcribe = (pcm = new Uint8Array(new Float32Array([0, 0.5]).buffer)) =>
      service
        .transcribe(provider, pcm, {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "en",
          speechCustomWords: ["T3 Code", ...words].map((term) => ({ term, aliases: [] })),
          speechHints: ["Server"],
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey(provider === "openai" ? "xai" : "openai", Redacted.make("other"));
    expect((yield* Effect.flip(transcribe()))._tag).toBe("CloudSpeechError");
    yield* service.setKey(provider, Redacted.make("chosen"));
    expect(yield* service.configured).toEqual({ openai: true, xai: true, openrouter: false });
    yield* Effect.flip(transcribe(new Uint8Array(3)));
    expect(upstream).not.toHaveBeenCalled();
    expect(yield* transcribe()).toBe("hello");
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe(
      {
        openai: "https://api.openai.com/v1/audio/transcriptions",
        xai: "https://api.x.ai/v1/stt",
      }[provider],
    );
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer chosen");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe(
      provider === "openai" ? "gpt-transcribe" : "grok-voice-transcribe-2.0",
    );
    expect(form.getAll(provider === "openai" ? "keywords[]" : "keyterm")).toEqual([
      "Server",
      "T3 Code",
      ...words.slice(0, 98),
    ]);
    expect(form.get(provider === "openai" ? "languages[]" : "language")).toBe("en");
    expect([...form.keys()].at(-1)).toBe("file");
    const wav = new DataView(yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()));
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getInt16(46, true)).toBe(16384);
    upstream.mockResolvedValueOnce(new Response("sensitive upstream diagnostic", { status: 401 }));
    expect(yield* Effect.flip(transcribe())).toMatchObject({ provider, reason: "rejected-key" });
    yield* service.setKey(provider, null);
    expect((yield* service.configured)[provider]).toBe(false);
    yield* Effect.flip(transcribe());
    expect(upstream).toHaveBeenCalledTimes(2);
    yield* service.setKey(provider, reference);
    expect((yield* service.configured)[provider]).toBe(true);
    expect(read).not.toHaveBeenCalled();
    resolved = "resolved-fixture";
    expect(yield* transcribe()).toBe("hello");
    expect(read).toHaveBeenCalledWith([reference]);
    expect(new Headers(upstream.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
      "Bearer resolved-fixture",
    );
    resolved = undefined;
    expect(yield* Effect.flip(transcribe())).toMatchObject({
      provider,
      reason: "unreadable-key",
    });
    expect(upstream).toHaveBeenCalledTimes(3);
  }),
);

it.effect("uploads to OpenRouter only for a listed exact model, as zero-retention JSON WAV", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/models")
        ? Response.json({ data: [{ id: "acme/transcribe-1" }, { id: "acme/transcribe-2" }] })
        : Response.json({ text: "hello" }),
    );
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeSocket.layerWebSocketConstructor),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const uploads = () =>
      upstream.mock.calls.filter(([url]) => String(url).endsWith("/audio/transcriptions"));
    const transcribe = (model: string | undefined) =>
      service
        .transcribe(
          "openrouter",
          new Uint8Array(new Float32Array([0, 0.5]).buffer),
          { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "en" },
          model,
        )
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey("openrouter", Redacted.make("router-key"));
    expect(yield* Effect.flip(transcribe(undefined))).toMatchObject({ provider: "openrouter" });
    upstream.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(yield* Effect.flip(transcribe("acme/transcribe-2"))).toMatchObject({
      reason: "unavailable",
    });
    expect(yield* Effect.flip(transcribe("acme/delisted"))).toMatchObject({
      provider: "openrouter",
    });
    expect(uploads()).toEqual([]);
    expect(yield* transcribe("acme/transcribe-2")).toBe("hello");
    const [[url, init]] = uploads() as [[URL, RequestInit]];
    expect(new URL(String(upstream.mock.calls[0]![0])).searchParams.get("zdr")).toBe("true");
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer router-key");
    expect(headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(yield* Effect.promise(() => new Response(init.body).text())) as {
      model: string;
      models?: unknown;
      provider: { zdr: boolean };
      input_audio: { format: string; data: string };
    };
    expect(body).toMatchObject({
      model: "acme/transcribe-2",
      provider: { zdr: true },
      input_audio: { format: "wav" },
    });
    expect(body.models).toBeUndefined();
    const wav = Buffer.from(body.input_audio.data, "base64");
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readInt16LE(46)).toBe(16384);
  }),
);

it.effect("removing a key while a catalog read is pending prevents the upload", () =>
  Effect.gen(function* () {
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeSocket.layerWebSocketConstructor),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const catalogStarted = Promise.withResolvers<void>();
    const catalog = Promise.withResolvers<Response>();
    const uploads: string[] = [];
    const upstream: typeof fetch = async (input) => {
      if (new URL(String(input)).pathname.endsWith("/models")) {
        catalogStarted.resolve();
        return catalog.promise;
      }
      uploads.push(String(input));
      return Response.json({ text: "unexpected" });
    };
    yield* service.setKey("openrouter", Redacted.make("old-key"));
    const job = yield* service
      .transcribe(
        "openrouter",
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        "acme/voice",
      )
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.forkChild);
    yield* Effect.promise(() => catalogStarted.promise);
    yield* service.setKey("openrouter", null);
    catalog.resolve(Response.json({ data: [{ id: "acme/voice" }] }));
    const exit = yield* Fiber.await(job);
    expect(uploads).toEqual([]);
    expect(exit._tag).toBe("Failure");
  }),
);

it.live("streams dictation to xAI live and finishes with the corrected transcript", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const samples: number[] = [];
    const controls: string[] = [];
    const routes = HttpRouter.add(
      "GET",
      "/v1/stt",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        requests.push({ url: request.url, authorization: request.headers.authorization });
        const failing = request.headers.authorization === "Bearer failing-key";
        if (!failing && request.headers.authorization !== "Bearer live-key")
          return HttpServerResponse.empty({ status: 401 });
        const socket = yield* request.upgrade;
        yield* Effect.gen(function* () {
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          const send = (event: object) => writer.write(JSON.stringify(event));
          yield* send({ type: "transcript.created" });
          if (failing) {
            yield* reader.pull;
            return yield* send({ type: "error", message: "upstream detail" });
          }
          while (true) {
            for (const frame of yield* reader.pull) {
              if (typeof frame === "string") {
                controls.push(frame);
                // xAI restates the whole utterance once it ends, then sends an empty done event.
                yield* send({
                  type: "transcript.partial",
                  text: "um T three code is live",
                  is_final: true,
                  speech_final: true,
                });
                return yield* send({ type: "transcript.done", text: "" });
              }
              samples.push(
                new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getInt16(0, true),
              );
              if (samples.length === 1)
                yield* send({
                  type: "transcript.partial",
                  text: "um T three code",
                  is_final: true,
                });
              if (samples.length === 2)
                yield* send({ type: "transcript.partial", text: "is live", is_final: false });
            }
          }
        }).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
    const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
    const origin = `ws://127.0.0.1:${address.port}`;
    // Points the real xAI URL at the local server and tells the test when a reply was handled.
    let replied: (() => void) | undefined;
    const nextReply = () => new Promise<void>((resolve) => (replied = resolve));
    const connect = yield* Socket.WebSocketConstructor.pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
              expect(url.startsWith("wss://api.x.ai/v1/stt?")).toBe(true);
              const socket = connect(`${origin}/v1/stt${new URL(url).search}`, options);
              socket.addEventListener("message", () => replied?.());
              return socket;
            }),
          ),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const options = {
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "en" as const,
      speechCustomWords: [{ term: "T3 Code", aliases: ["T three code"] }],
    };
    const pcm = (sample: number) => new Uint8Array(new Float32Array([sample]).buffer);

    yield* service.setKey("xai", Redacted.make("wrong-key"));
    expect(yield* Effect.flip(service.startStream("xai", options))).toMatchObject({
      provider: "xai",
      reason: "unavailable",
    });

    yield* service.setKey("xai", Redacted.make("live-key"));
    const stream = yield* service.startStream("xai", options);
    const query = new URL(requests[1]!.url, origin).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      model: "grok-voice-transcribe-2.0",
      sample_rate: "16000",
      encoding: "pcm",
      interim_results: "true",
      language: "en",
      format: "true",
      filler_words: "false",
    });
    expect(query.getAll("keyterm")).toEqual(["T3 Code"]);

    let reply = nextReply();
    expect(yield* stream.feed(pcm(0.5))).toEqual({ revision: 0, text: null });
    yield* Effect.promise(() => reply);
    reply = nextReply();
    expect(yield* stream.feed(pcm(-0.5))).toEqual({
      revision: 1,
      text: { committed: "um T3 Code", tentative: "" },
    });
    yield* Effect.promise(() => reply);
    expect(yield* stream.feed(pcm(0))).toEqual({
      revision: 2,
      text: { committed: "um T3 Code", tentative: " is live" },
    });
    // No newer xAI result: the frame is acknowledged without resending the same text.
    expect(yield* stream.feed(pcm(0))).toEqual({ revision: 2, text: null });
    expect(yield* stream.finish).toBe("T3 Code is live");
    expect(samples).toEqual([16384, -16384, 0, 0]);
    expect(controls).toEqual(['{"type":"audio.done"}']);

    // An xAI error mid-recording fails the next frame and the finish without upstream detail.
    yield* service.setKey("xai", Redacted.make("failing-key"));
    const failing = yield* service.startStream("xai", options);
    reply = nextReply();
    yield* failing.feed(pcm(0.5));
    yield* Effect.promise(() => reply);
    expect(yield* Effect.flip(failing.feed(pcm(0.5)))).toMatchObject({ reason: "unavailable" });
    expect(yield* Effect.flip(failing.finish)).toMatchObject({ reason: "unavailable" });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

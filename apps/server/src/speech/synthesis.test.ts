import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";
import {
  LocalSpeechSynthesis,
  localSynthesisLanguage,
  localSynthesisRuntime,
} from "./LocalSpeechSynthesis.ts";
import { encodeMp3, encodeMp3Stream, leadingSentence, pcm16Mono } from "./synthesisAudio.ts";
import * as SpeechSynthesisStreams from "./synthesisStreams.ts";

it("encodes model samples as clipped mono 16-bit PCM", () => {
  const pcm = pcm16Mono(Float32Array.of(0, 1, -1, 2, -2, Number.NaN, 0.5), 1);
  expect([...pcm]).toEqual([0, 32767, -32768, 32767, -32768, 0, 16383]);
  expect([...pcm16Mono(Float32Array.of(1, -1, 0.5, 0.5), 2)]).toEqual([0, 16383]);
});

const longLine = `${"word ".repeat(40)}end.`;
it.each([
  ["Fixed it.\nThe cause was a race.\nDone.", ["Fixed it.", "The cause was a race.\nDone."]],
  ["Only one sentence.", ["Only one sentence."]],
  [`${longLine}\nNext.`, [`${longLine}\nNext.`]],
])("synthesizes a short opening sentence on its own: %j", (text, parts) => {
  expect(leadingSentence(text)).toEqual(parts);
});

// An MPEG audio frame header's version bits and sample-rate index give the encoded rate.
function mp3SampleRate(bytes: Uint8Array) {
  expect(bytes[0]).toBe(0xff);
  const rates = { 0: [11025, 12000, 8000], 2: [22050, 24000, 16000], 3: [44100, 48000, 32000] };
  return rates[((bytes[1]! >> 3) & 3) as 0 | 2 | 3][(bytes[2]! >> 2) & 3];
}

// lamejs's resampler turns speech into near-silence, so the encoded rate must match the input.
it.effect.each([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])(
  "encodes %i Hz speech without resampling it",
  (rate) =>
    Effect.gen(function* () {
      const pcm = new Uint8Array(rate * 2);
      const [first] = yield* Stream.runCollect(Stream.take(encodeMp3(pcm, rate), 1));
      expect(mp3SampleRate(first!)).toBe(rate);
    }),
);

it.each([
  ["en-US", "en"],
  ["PT", "pt"],
  ["auto", undefined],
  ["xx", undefined],
])("maps the %s reading language onto a local model language", (setting, language) => {
  expect(localSynthesisLanguage(setting, ["en", "pt", "ko"])).toBe(language);
});

it.each([
  {
    platform: "darwin",
    architecture: "arm64",
    libc: undefined,
    glibc: undefined,
    backend: "metal",
  },
  { platform: "darwin", architecture: "x64", libc: undefined, glibc: undefined, backend: "cpu" },
  { platform: "win32", architecture: "x64", libc: undefined, glibc: undefined, backend: "vulkan" },
  { platform: "linux", architecture: "x64", libc: "gnu", glibc: "2.28", backend: "vulkan" },
  { platform: "linux", architecture: "arm64", libc: "gnu", glibc: "2.39", backend: "vulkan" },
  {
    platform: "linux",
    architecture: "x64",
    libc: "gnu",
    glibc: "2.17",
    error: "glibc 2.28 or newer",
  },
  {
    platform: "linux",
    architecture: "x64",
    libc: "musl",
    glibc: undefined,
    error: "not available",
  },
  {
    platform: "freebsd",
    architecture: "x64",
    libc: undefined,
    glibc: undefined,
    error: "not available",
  },
  {
    platform: "win32",
    architecture: "arm64",
    libc: undefined,
    glibc: undefined,
    backend: "vulkan",
  },
] as const)(
  "installs the speech build that loads on $platform-$architecture with glibc $glibc",
  ({ backend, error, ...host }) => {
    const result = localSynthesisRuntime(host);
    expect(result.runtime?.backend).toBe(backend);
    if (error) expect(result.error).toContain(error);
    else expect(result.error).toBeUndefined();
  },
);

it.effect("lists ElevenLabs voices by name and sends its key only in its own header", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/v2/voices")
        ? Response.json({ voices: [{ voice_id: "voice-123", name: "Rachel" }] })
        : String(url).endsWith("/v1/models")
          ? Response.json([
              {
                model_id: "eleven_multilingual_v2",
                name: "Multilingual v2",
                can_do_text_to_speech: true,
              },
              {
                model_id: "eleven_english_sts_v2",
                name: "Speech to speech",
                can_do_text_to_speech: false,
              },
            ])
          : new Response(
              `${JSON.stringify({
                audio_base64: Buffer.from([73, 68, 51, 1]).toString("base64"),
                alignment: null,
              })}\n`,
              { headers: { "content-type": "application/json" } },
            ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CloudSpeech.CloudSpeech;
      const synthesize = (request: Parameters<typeof service.stream>[1]) =>
        service.stream("elevenlabs", request).pipe(
          Stream.runCollect,
          Effect.map((parts) =>
            Uint8Array.from(parts.flatMap((part) => (part instanceof Uint8Array ? [...part] : []))),
          ),
        );
      const request = {
        text: "Read this reply.",
        model: "",
        voice: "",
        speed: 1.25,
        language: "en",
      };
      expect(yield* Effect.flip(synthesize(request))).toMatchObject({ reason: "missing-key" });
      expect(upstream).not.toHaveBeenCalled();
      yield* service.setKey("elevenlabs", Redacted.make("speech-key"));
      expect(yield* service.synthesisModels("elevenlabs")).toMatchObject({
        apiKeyProvider: "elevenlabs",
        defaultModel: "eleven_multilingual_v2",
        speedAppliedByProvider: false,
        wordTimings: "provider",
        models: [
          {
            id: "eleven_multilingual_v2",
            name: "Multilingual v2",
            voices: ["voice-123"],
            voiceNames: { "voice-123": "Rachel" },
          },
        ],
      });
      expect([...(yield* synthesize(request))]).toEqual([73, 68, 51, 1]);
      expect([
        ...(yield* synthesize({ ...request, voice: "voice-123", model: "eleven_v3" })),
      ]).toEqual([73, 68, 51, 1]);
      for (const [url, init] of upstream.mock.calls) {
        expect(String(url).startsWith("https://api.elevenlabs.io/")).toBe(true);
        expect(new Headers(init?.headers).get("xi-api-key")).toBe("speech-key");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
      }
      const [defaultUrl, defaultInit] = upstream.mock.calls.at(-2)!;
      expect(String(defaultUrl)).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream/with-timestamps?output_format=mp3_44100_64",
      );
      expect(JSON.parse(String(defaultInit?.body))).toEqual({
        text: "Read this reply.",
        model_id: "eleven_multilingual_v2",
      });
      const [chosenUrl, chosenInit] = upstream.mock.calls.at(-1)!;
      expect(String(chosenUrl)).toContain("/v1/text-to-speech/voice-123/stream/with-timestamps");
      expect(JSON.parse(String(chosenInit?.body)).model_id).toBe("eleven_v3");
    }).pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, upstream),
    );
  }),
);

it.effect("places ElevenLabs word timings of later pieces after the earlier pieces' audio", () =>
  Effect.gen(function* () {
    // Two MPEG-1 Layer III frames at 64 kbps and 44.1 kHz.
    const frame = Uint8Array.from({ length: 208 }, (_, index) =>
      index === 0 ? 0xff : index === 1 ? 0xfb : index === 2 ? 0x50 : 0,
    );
    const pieceSeconds = (2 * 1152) / 44100;
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const { text } = JSON.parse(String(init?.body)) as { text: string };
      const characters = Array.from(text);
      return new Response(
        [
          {
            audio_base64: null,
            alignment: {
              characters,
              character_start_times_seconds: characters.map((_, index) => index / 100),
              character_end_times_seconds: characters.map((_, index) => (index + 1) / 100),
            },
          },
          { audio_base64: Buffer.from([...frame, ...frame]).toString("base64"), alignment: null },
        ]
          .map((chunk) => JSON.stringify(chunk))
          .join("\n"),
      );
    });
    const text = Array.from({ length: 250 }, (_, index) => `w${index}.`).join(" ");
    const words = yield* Effect.gen(function* () {
      const service = yield* CloudSpeech.CloudSpeech;
      yield* service.setKey("elevenlabs", Redacted.make("speech-key"));
      return yield* service
        .stream("elevenlabs", { text, model: "", voice: "", speed: 1, language: "en" })
        .pipe(
          Stream.runCollect,
          Effect.map((parts) => parts.flatMap((part) => ("words" in part ? part.words : []))),
        );
    }).pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, upstream),
    );
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(words.map((word) => text.slice(word.start, word.end))).toEqual(text.split(" "));
    const second = (JSON.parse(String(upstream.mock.calls[1]?.[1]?.body)) as { text: string }).text;
    const first = words.find((word) => word.start === text.indexOf(second));
    expect(first?.startSeconds).toBeCloseTo(pieceSeconds, 6);
    expect(words.at(-1)?.startSeconds).toBeCloseTo(
      pieceSeconds + (second.length - second.split(" ").at(-1)!.length) / 100,
      6,
    );
  }),
);

it.effect("speaks OpenAI replies over Realtime sessions and fails on a provider error", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })),
      (server) => Effect.sync(() => server.close()),
    );
    if (!server.address())
      yield* Effect.promise(() => new Promise((resolve) => server.once("listening", resolve)));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("Missing server port");
    const { port } = address;
    // A tone, so samples read out of step encode differently.
    const pcm = new Uint8Array(
      Int16Array.from({ length: 4800 }, (_, index) => 8000 * Math.sin(index / 7)).buffer,
    );
    // An odd split ends the first delta inside a sample.
    const audio = [pcm.subarray(0, 4801), pcm.subarray(4801)].map((delta) => ({
      type: "response.output_audio.delta",
      delta: Buffer.from(delta).toString("base64"),
    }));
    let reply: unknown[] = [...audio, { type: "response.done", response: { status: "completed" } }];
    const urls: string[] = [];
    const keys: unknown[] = [];
    const sent: unknown[] = [];
    let created = Promise.withResolvers<void>();
    server.on("connection", (socket, request) => {
      keys.push(request.headers.authorization);
      socket.on("message", (data) => {
        const event = JSON.parse(String(data));
        sent.push(event);
        if (event.type === "response.create") created.resolve();
        const answers = event.type === "session.update" ? [{ type: "session.updated" }] : reply;
        for (const answer of answers)
          if (answer === "close") socket.close();
          else socket.send(JSON.stringify(answer));
      });
    });
    const NativeWebSocket = globalThis.WebSocket;
    vi.stubGlobal(
      "WebSocket",
      class extends NativeWebSocket {
        constructor(url: string | URL, init?: ConstructorParameters<typeof NativeWebSocket>[1]) {
          urls.push(String(url));
          super(`ws://127.0.0.1:${port}`, init);
        }
      },
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    const bytes = <E>(stream: Stream.Stream<CloudSpeech.SpeechSynthesisPart, E>) =>
      stream.pipe(
        Stream.runCollect,
        Effect.map((parts) =>
          Uint8Array.from(parts.flatMap((part) => (part instanceof Uint8Array ? [...part] : []))),
        ),
      );
    const request = {
      text: "Merged #35910 after 840 tests.",
      // Settings saved for the retired speech models still read aloud.
      model: "gpt-4o-mini-tts",
      voice: "fable",
      speed: 1.25,
      language: "auto",
    };
    const synthesize = (overrides: Partial<typeof request>) =>
      bytes(service.stream("openai", { ...request, ...overrides }));
    yield* service.setKey("openai", Redacted.make("speech-key"));
    const mp3 = yield* synthesize({});
    expect(mp3SampleRate(mp3)).toBe(24000);
    expect(mp3).toEqual(yield* bytes(encodeMp3Stream(Stream.make(pcm), 24000)));
    yield* synthesize({ voice: "cedar", language: "es" });
    expect(urls).toEqual(Array(2).fill("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1"));
    expect(keys).toEqual(["Bearer speech-key", "Bearer speech-key"]);
    const input = (text: string) => [{ type: "message", role: "user", content: [{ text }] }];
    expect(sent).toMatchObject([
      {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: expect.stringContaining("word for word"),
          output_modalities: ["audio"],
          audio: {
            input: { turn_detection: null },
            output: { voice: "marin", format: { type: "audio/pcm", rate: 24000 } },
          },
        },
      },
      {
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["audio"],
          input: input(
            '{"text":"Merged number three five nine one zero after eight hundred forty tests."}',
          ),
        },
      },
      // Spanish keeps its digits for the voice to read in Spanish.
      { session: { audio: { output: { voice: "cedar" } } } },
      { response: { input: input('{"text":"Merged #35910 after 840 tests."}') } },
    ]);
    const catalog = yield* service.synthesisModels("openai");
    expect(catalog).toMatchObject({
      defaultModel: "gpt-realtime-2.1",
      speedAppliedByProvider: false,
      models: [{ id: "gpt-realtime-2.1", voices: expect.arrayContaining(["marin", "cedar"]) }],
    });
    // Like xAI and OpenRouter, it sends no word timings: players spread the words over the audio
    // length that the timings give once synthesis ends.
    expect(catalog).not.toHaveProperty("wordTimings");
    const timings = yield* Effect.gen(function* () {
      const streams = yield* SpeechSynthesisStreams.SpeechSynthesisStreams;
      return yield* streams.timings(yield* streams.start("openai", request), 0);
    }).pipe(
      Effect.provide(
        SpeechSynthesisStreams.layer.pipe(
          Layer.provide(Layer.mock(CloudSpeech.CloudSpeech)({ stream: service.stream })),
          Layer.provide(Layer.mock(LocalSpeechSynthesis)({})),
          Layer.provide(SecureRandom.layerWebCrypto),
        ),
      ),
    );
    expect(timings).toEqual({ words: [], done: true, durationSeconds: expect.any(Number) });
    // The 0.2 s tone fills 11 frames of 576 samples with the encoder's delay and padding.
    expect(timings.durationSeconds).toBeCloseTo((11 * 576) / 24000, 6);
    for (const [event, reason] of [
      [
        { type: "error", error: { code: "invalid_api_key", message: "private diagnostic" } },
        "rejected-key",
      ],
      [
        {
          type: "response.done",
          response: { status: "failed", status_details: { error: { code: "insufficient_quota" } } },
        },
        "rate-limit",
      ],
      [{ type: "response.done", response: { status: "incomplete" } }, "unavailable"],
      // A session that closes before `response.done` never passes for complete audio.
      ["close", "unavailable"],
    ] as const) {
      reply = [audio[0], event];
      const failure = yield* Effect.flip(synthesize({}));
      expect(failure).toMatchObject({ provider: "openai", reason });
      expect(failure.message).not.toContain("private diagnostic");
    }
    // A session that never answers fails at the stall timeout.
    reply = [];
    created = Promise.withResolvers<void>();
    const stalled = yield* Effect.forkChild(Effect.flip(synthesize({})));
    yield* Effect.promise(() => created.promise);
    yield* TestClock.adjust("30 seconds");
    expect(yield* Fiber.join(stalled)).toMatchObject({ provider: "openai", reason: "unavailable" });
  }),
);

it.effect.each(["xai", "openrouter"] as const)(
  "synthesizes with %s without leaking keys to another destination",
  (provider) =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith("/voices")
          ? Response.json({ voices: [{ voice_id: "reader" }] })
          : String(url).includes("/models")
            ? Response.json({
                data: [
                  { id: "google/gemini-test-tts", name: "Speech", supported_voices: ["reader"] },
                  { id: "minimax/speech-test:free", supported_voices: null },
                ],
              })
            : new Response(new Uint8Array([73, 68, 51, 1]), {
                headers: {
                  "content-type":
                    provider === "openrouter" ? "audio/pcm;rate=44100;channels=1" : "audio/mpeg",
                },
              }),
      );
      const settingsLayer = ServerSettings.ServerSettingsService.layerTest();
      const program = Effect.gen(function* () {
        const service = yield* CloudSpeech.CloudSpeech;
        const synthesize = (...args: Parameters<typeof service.stream>) =>
          service.stream(...args).pipe(
            Stream.runCollect,
            Effect.map((parts) =>
              Uint8Array.from(
                parts.flatMap((part) => (part instanceof Uint8Array ? [...part] : [])),
              ),
            ),
          );
        yield* service.setKey("openai", Redacted.make("must-not-be-forwarded"));
        const request = {
          text: "Read this reply.",
          model: "google/gemini-test-tts",
          voice: "reader",
          speed: 1.25,
          language: "en",
        };
        expect(yield* Effect.flip(synthesize(provider, request))).toMatchObject({
          reason: "missing-key",
        });
        expect(upstream).not.toHaveBeenCalled();
        if (provider === "xai") {
          expect(yield* service.synthesisModels(provider)).toMatchObject({
            apiKeyProvider: "xai",
            defaultModel: "grok-tts",
            models: [],
            error: expect.stringContaining("Add your"),
          });
          expect(upstream).not.toHaveBeenCalled();
        }
        yield* service.setKey(provider, Redacted.make("speech-key"));
        if (provider === "openrouter") {
          const requested = Promise.withResolvers<void>();
          const catalog = Promise.withResolvers<Response>();
          upstream.mockImplementationOnce(async () => {
            requested.resolve();
            return catalog.promise;
          });
          const pending = yield* Effect.forkChild(
            Effect.flip(synthesize(provider, { ...request, voice: "" })),
          );
          yield* Effect.promise(() => requested.promise);
          yield* service.setKey(provider, null);
          catalog.resolve(
            Response.json({
              data: [
                { id: request.model, name: "Speech", supported_voices: ["reader"] },
                { id: "minimax/speech-test:free", supported_voices: null },
              ],
            }),
          );
          expect(yield* Fiber.join(pending)).toMatchObject({ reason: "key-changed" });
          expect(upstream).toHaveBeenCalledTimes(1);
          yield* service.setKey(provider, Redacted.make("speech-key"));
          upstream.mockClear();
        }
        const result = yield* synthesize(provider, request);
        if (provider === "openrouter") expect(mp3SampleRate(result)).toBe(44100);
        else expect([...result]).toEqual([73, 68, 51, 1]);
        const [url, init] = upstream.mock.calls[0]!;
        expect(String(url)).toBe(
          {
            xai: "https://api.x.ai/v1/tts",
            openrouter: "https://openrouter.ai/api/v1/audio/speech",
          }[provider],
        );
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer speech-key");
        expect(init?.redirect).toBe("error");
        expect(JSON.parse(String(init?.body))).toMatchObject(
          provider === "xai"
            ? { text: request.text, voice_id: request.voice, language: "en", speed: 1.25 }
            : {
                input: request.text,
                model: request.model,
                voice: request.voice,
                response_format: "pcm",
              },
        );
        if (provider === "openrouter")
          expect(JSON.parse(String(init?.body))).not.toHaveProperty("speed");
        else expect(JSON.parse(String(init?.body)).speed).toBe(1.25);
        const catalog = yield* service.synthesisModels(provider);
        expect(catalog).toMatchObject({
          apiKeyProvider: provider,
          defaultModel: provider === "xai" ? "grok-tts" : "google/gemini-test-tts",
          speedAppliedByProvider: provider !== "openrouter",
          supportsModelSelection: true,
          supportsVoiceSelection: true,
        });
        expect(catalog.models).toEqual(
          provider === "xai"
            ? [{ id: "grok-tts", name: "Grok TTS", voices: ["reader"] }]
            : [
                { id: "google/gemini-test-tts", name: "Speech", voices: ["reader"] },
                { id: "minimax/speech-test:free", name: "minimax/speech-test:free", voices: [] },
              ],
        );
        if (provider === "xai") {
          expect(new Headers(upstream.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe(
            "Bearer speech-key",
          );
        }
        if (provider === "openrouter") {
          yield* synthesize(provider, { ...request, voice: "" });
          expect(JSON.parse(String(upstream.mock.calls.at(-1)?.[1]?.body)).voice).toBe("reader");
          for (const [model, expectedRate] of [
            ["google/gemini-tts", 24000],
            ["heygen/heygen-voice-1", 44100],
          ] as const) {
            upstream.mockResolvedValueOnce(
              new Response(Uint8Array.of(0, 1), { headers: { "content-type": "audio/pcm" } }),
            );
            const plainPcm = yield* synthesize(provider, {
              ...request,
              model,
              voice: "reader",
            });
            expect(mp3SampleRate(plainPcm)).toBe(expectedRate);
          }
          for (const model of ["minimax/speech-test:free", "mistralai/voxtral-mini-tts-2603"]) {
            upstream.mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51, 1])));
            expect([
              ...(yield* synthesize(provider, {
                ...request,
                model,
              })),
            ]).toEqual([73, 68, 51, 1]);
            expect(JSON.parse(String(upstream.mock.calls.at(-1)?.[1]?.body)).response_format).toBe(
              "mp3",
            );
          }
          for (const contentType of [
            "audio/pcm;rate=garbage",
            "audio/pcm;rate=",
            "audio/pcm;channels=",
          ]) {
            upstream.mockResolvedValueOnce(
              new Response(new Uint8Array([0, 1]), { headers: { "content-type": contentType } }),
            );
            expect(yield* Effect.flip(synthesize(provider, request))).toMatchObject({
              reason: "unavailable",
            });
          }
        }
        upstream.mockResolvedValueOnce(
          new Response("private upstream diagnostic", { status: 429 }),
        );
        expect(yield* Effect.flip(synthesize(provider, request))).toMatchObject({
          reason: "rate-limit",
        });
        upstream.mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("private stream diagnostic"));
              },
            }),
          ),
        );
        const streamFailure = yield* Effect.flip(synthesize(provider, request));
        expect(streamFailure).toHaveProperty("cause");
        expect(streamFailure.message).not.toContain("private stream diagnostic");
        const reading = Promise.withResolvers<void>();
        upstream.mockResolvedValueOnce(
          new Response(
            // No buffer, so pull runs only once synthesis reads the body.
            new ReadableStream<Uint8Array>(
              {
                pull: () => {
                  reading.resolve();
                  return new Promise(() => {});
                },
              },
              { highWaterMark: 0 },
            ),
          ),
        );
        const stalled = yield* Effect.forkChild(Effect.flip(synthesize(provider, request)));
        yield* Effect.promise(() => reading.promise);
        yield* TestClock.adjust("2 minutes");
        expect(yield* Fiber.join(stalled)).toMatchObject({ reason: "unavailable" });
        for (const operation of ["catalog", "synthesis"] as const) {
          let pulls = 0;
          const cancel = vi.fn();
          upstream.mockResolvedValueOnce(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (++pulls <= 40) controller.enqueue(new Uint8Array(1024 * 1024));
                  else controller.close();
                },
                cancel,
              }),
            ),
          );
          if (operation === "catalog") {
            if (provider === "openrouter") yield* TestClock.adjust("10 minutes");
            const failedCatalog = yield* service.synthesisModels(provider);
            expect(failedCatalog.error).toBeDefined();
            expect(failedCatalog.apiKeyProvider).toBe(provider);
          } else
            expect(yield* Effect.flip(synthesize(provider, request))).toMatchObject({
              reason: "unavailable",
            });
          expect(pulls).toBeLessThan(40);
          expect(cancel).toHaveBeenCalledOnce();
        }
        yield* service.setKey(provider, null);
        const count = upstream.mock.calls.length;
        expect(yield* Effect.flip(synthesize(provider, request))).toMatchObject({
          reason: "missing-key",
        });
        expect(upstream.mock.calls.length).toBe(count);
      });
      yield* program.pipe(
        Effect.provide(
          CloudSpeech.layer.pipe(
            Layer.provide(NodeServices.layer),
            Layer.provideMerge(settingsLayer),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, upstream),
      );
    }),
);

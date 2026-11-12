import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

it.effect.each([
  {
    provider: "openai",
    url: "https://api.openai.com/v1/audio/transcriptions",
    fields: [
      ["model", "gpt-transcribe"],
      ["languages[]", "en"],
      ["keywords[]", "T3 Code"],
    ],
    autoFields: ["model", "keywords[]", "file"],
  },
  {
    provider: "xai",
    url: "https://api.x.ai/v1/stt",
    fields: [
      ["model", "grok-voice-transcribe-2.0"],
      ["language", "en"],
      ["keyterm", "T3 Code"],
      ["format", "true"],
      ["filler_words", "false"],
    ],
    autoFields: ["model", "keyterm", "filler_words", "file"],
  },
  {
    provider: "groq",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    fields: [
      ["model", "whisper-large-v3-turbo"],
      ["language", "en"],
    ],
    autoFields: ["model", "file"],
  },
] as const)(
  "sends only to $provider using its own saved key",
  ({ provider, url, fields, autoFields }) =>
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
      const transcribe = (
        pcm = new Uint8Array(new Float32Array([0, 0.5]).buffer),
        speechLanguage = "en",
      ) =>
        service
          .transcribe(provider, pcm, {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            speechLanguage,
            speechCustomWords: [{ term: "T3 Code", aliases: [] }],
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      const other = provider === "openai" ? "xai" : "openai";
      yield* service.setKey(other, Redacted.make("other"));
      expect((yield* Effect.flip(transcribe()))._tag).toBe("CloudSpeechError");
      yield* service.setKey(provider, Redacted.make("chosen"));
      expect(yield* service.configured).toEqual({
        openai: false,
        xai: false,
        groq: false,
        openrouter: false,
        [other]: true,
        [provider]: true,
      });
      yield* Effect.flip(transcribe(new Uint8Array(3)));
      expect(upstream).not.toHaveBeenCalled();
      expect(yield* transcribe()).toBe("hello");
      const [sentTo, init] = upstream.mock.calls[0]!;
      expect(String(sentTo)).toBe(url);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer chosen");
      const form = init?.body as FormData;
      expect([...form.entries()]).toEqual([...fields, ["file", expect.any(Blob)]]);
      const wav = new DataView(
        yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()),
      );
      expect(wav.getUint32(24, true)).toBe(16_000);
      expect(wav.getInt16(46, true)).toBe(16384);
      expect(yield* transcribe(undefined, "auto")).toBe("hello");
      const autoForm = upstream.mock.calls[1]![1]!.body as FormData;
      expect([...autoForm.keys()]).toEqual(autoFields);
      upstream.mockResolvedValueOnce(
        new Response("sensitive upstream diagnostic", { status: 401 }),
      );
      expect(yield* Effect.flip(transcribe())).toMatchObject({ provider, reason: "rejected-key" });
      yield* service.setKey(provider, null);
      expect((yield* service.configured)[provider]).toBe(false);
      yield* Effect.flip(transcribe());
      expect(upstream).toHaveBeenCalledTimes(3);
      yield* service.setKey(provider, reference);
      expect((yield* service.configured)[provider]).toBe(true);
      expect(read).not.toHaveBeenCalled();
      resolved = "resolved-fixture";
      expect(yield* transcribe()).toBe("hello");
      expect(read).toHaveBeenCalledWith([reference]);
      expect(new Headers(upstream.mock.calls[3]?.[1]?.headers).get("authorization")).toBe(
        "Bearer resolved-fixture",
      );
      resolved = undefined;
      expect(yield* Effect.flip(transcribe())).toMatchObject({
        provider,
        reason: "unreadable-key",
      });
      expect(upstream).toHaveBeenCalledTimes(4);
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

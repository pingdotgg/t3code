import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
    const transcribe = (pcm = new Uint8Array(new Float32Array([0, 0.5]).buffer)) =>
      service
        .transcribe(provider, pcm, {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "en",
          speechCustomWords: [{ term: "T3 Code", aliases: [] }],
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    yield* service.setKey(provider === "openai" ? "xai" : "openai", Redacted.make("other"));
    expect((yield* Effect.flip(transcribe()))._tag).toBe("CloudSpeechError");
    yield* service.setKey(provider, Redacted.make("chosen"));
    expect(yield* service.configured).toEqual({
      openai: true,
      xai: true,
      openrouter: false,
      soniox: false,
    });
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
    expect(form.getAll(provider === "openai" ? "keywords[]" : "keyterm")).toEqual(["T3 Code"]);
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

it.effect.each([false, true])(
  "transcribes Soniox uploads with vocabulary hints and deletes temporary data (slow upload: %s)",
  (slowUpload) =>
    Effect.gen(function* () {
      const polled = yield* Deferred.make<void>();
      const uploading = yield* Deferred.make<void>();
      const upload = Promise.withResolvers<Response>();
      let polls = 0;
      const upstream = vi.fn<typeof fetch>(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (path === "/v1/files") {
          if (slowUpload && polls === 0) {
            Deferred.doneUnsafe(uploading, Effect.void);
            return upload.promise;
          }
          return Response.json({ id: "file-id" });
        }
        if (path === "/v1/transcriptions") return Response.json({ id: "job-id" });
        if (path.endsWith("/transcript")) return Response.json({ text: " uh tea three " });
        polls++;
        if (polls === 1) {
          Deferred.doneUnsafe(polled, Effect.void);
          return Response.json({ status: "processing" });
        }
        return Response.json({ status: "completed" });
      });
      const service = yield* CloudSpeech.CloudSpeech.pipe(
        Effect.provide(
          CloudSpeech.layer.pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
          ),
        ),
      );
      const transcribe = (language = "en") =>
        service
          .transcribe("soniox", new Uint8Array(new Float32Array([0, 0.5]).buffer), {
            ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
            speechLanguage: language,
            speechCustomWords: [{ term: "T3", aliases: ["tea three"] }],
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      yield* service.setKey("openai", Redacted.make("other-key"));
      expect(yield* Effect.flip(transcribe())).toMatchObject({ reason: "missing-key" });
      expect(upstream).not.toHaveBeenCalled();
      yield* service.setKey("soniox", Redacted.make("soniox-key"));
      expect((yield* service.configured).soniox).toBe(true);
      const fiber = yield* transcribe().pipe(Effect.forkChild);
      if (slowUpload) {
        yield* Deferred.await(uploading);
        yield* TestClock.adjust("20 seconds");
        upload.resolve(Response.json({ id: "file-id" }));
      }
      yield* Effect.raceFirst(Deferred.await(polled), Fiber.join(fiber));
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("T3");
      expect(polls).toBe(2);
      expect(upstream.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
        "POST https://api.soniox.com/v1/files",
        "POST https://api.soniox.com/v1/transcriptions",
        "GET https://api.soniox.com/v1/transcriptions/job-id",
        "GET https://api.soniox.com/v1/transcriptions/job-id",
        "GET https://api.soniox.com/v1/transcriptions/job-id/transcript",
        "DELETE https://api.soniox.com/v1/transcriptions/job-id",
        "DELETE https://api.soniox.com/v1/files/file-id",
      ]);
      for (const [, init] of upstream.mock.calls) {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer soniox-key");
      }
      const form = upstream.mock.calls[0]![1]!.body as FormData;
      const wav = new DataView(
        yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()),
      );
      expect(wav.getUint32(24, true)).toBe(16_000);
      expect(wav.getInt16(46, true)).toBe(16384);
      const body = yield* Effect.promise(() =>
        new Response(upstream.mock.calls[1]![1]!.body).json(),
      );
      expect(body).toEqual({
        model: "stt-async-v6",
        file_id: "file-id",
        language_hints: ["en"],
        context: { terms: ["T3"] },
      });
      expect(yield* transcribe("auto")).toBe("T3");
      const auto = yield* Effect.promise(() =>
        new Response(upstream.mock.calls[8]![1]!.body).json(),
      );
      expect(auto).not.toHaveProperty("language_hints");
      yield* service.setKey("soniox", null);
      expect((yield* service.configured).soniox).toBe(false);
      expect(yield* Effect.flip(transcribe())).toMatchObject({ reason: "missing-key" });
    }),
);

it.effect.each([
  [401, "rejected-key"],
  [403, "rejected-key"],
  [429, "rate-limit"],
  [500, "unavailable"],
  ["error", "unavailable"],
  ["malformed", "unavailable"],
  ["cancel", "cancel"],
  ["timeout", "unavailable"],
] as const)("handles Soniox failure %s and releases uploaded data", ([failure, reason]) =>
  Effect.gen(function* () {
    const pending = yield* Deferred.make<void>();
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/v1/files") return Response.json({ id: "file-id" });
      if (path === "/v1/transcriptions") {
        if (typeof failure === "number")
          return new Response("sensitive diagnostic", { status: failure });
        return Response.json({ id: "job-id" });
      }
      Deferred.doneUnsafe(pending, Effect.void);
      return Response.json({
        status: failure === "cancel" || failure === "timeout" ? "processing" : failure,
      });
    });
    const service = yield* CloudSpeech.CloudSpeech.pipe(
      Effect.provide(
        CloudSpeech.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
        ),
      ),
    );
    yield* service.setKey("soniox", Redacted.make("fixture"));
    const run = service
      .transcribe(
        "soniox",
        new Uint8Array(new Float32Array([0.5]).buffer),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      )
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    if (failure === "cancel") {
      const fiber = yield* run.pipe(Effect.forkChild);
      yield* Deferred.await(pending);
      yield* Fiber.interrupt(fiber);
    } else if (failure === "timeout") {
      const fiber = yield* Effect.flip(run).pipe(Effect.forkChild);
      yield* Deferred.await(pending);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(fiber)).toMatchObject({ provider: "soniox", reason });
    } else {
      const error = yield* Effect.flip(run);
      expect(error).toMatchObject({ provider: "soniox", reason });
      expect(error.message).not.toContain("sensitive diagnostic");
    }
    expect(
      upstream.mock.calls
        .filter(([, init]) => init?.method === "DELETE")
        .map(([url]) => String(url)),
    ).toEqual([
      ...(typeof failure === "number" ? [] : ["https://api.soniox.com/v1/transcriptions/job-id"]),
      "https://api.soniox.com/v1/files/file-id",
    ]);
  }),
);

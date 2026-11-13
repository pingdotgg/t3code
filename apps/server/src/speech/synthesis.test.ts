import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

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
        yield* service.setKey("openai", Redacted.make("must-not-be-forwarded"));
        const request = {
          text: "Read this reply.",
          model: "google/gemini-test-tts",
          voice: "reader",
          speed: 1.25,
          language: "en",
        };
        expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
          reason: "missing-key",
        });
        expect(upstream).not.toHaveBeenCalled();
        yield* service.setKey(provider, Redacted.make("speech-key"));
        if (provider === "openrouter") {
          const requested = Promise.withResolvers<void>();
          const catalog = Promise.withResolvers<Response>();
          upstream.mockImplementationOnce(async () => {
            requested.resolve();
            return catalog.promise;
          });
          const pending = yield* Effect.forkChild(
            Effect.flip(service.synthesize(provider, { ...request, voice: "" })),
          );
          yield* Effect.promise(() => requested.promise);
          yield* service.setKey(provider, null);
          catalog.resolve(
            Response.json({ data: [{ id: request.model, supported_voices: ["reader"] }] }),
          );
          expect(yield* Fiber.join(pending)).toMatchObject({ reason: "key-changed" });
          expect(upstream).toHaveBeenCalledTimes(1);
          yield* service.setKey(provider, Redacted.make("speech-key"));
          upstream.mockClear();
        }
        const result = yield* service.synthesize(provider, request);
        if (provider === "openrouter") {
          expect(new TextDecoder().decode(result.slice(0, 4))).toBe("RIFF");
          const header = new DataView(result.buffer, result.byteOffset);
          expect(header.getUint32(24, true)).toBe(44100);
          expect(header.getUint32(40, true)).toBe(4);
          expect(result.slice(44)).toEqual(Uint8Array.of(73, 68, 51, 1));
        } else expect([...result]).toEqual([73, 68, 51, 1]);
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
            ? { text: request.text, voice_id: "reader", language: "en", speed: 1.25 }
            : {
                input: request.text,
                model: "google/gemini-test-tts",
                voice: "reader",
                response_format: "pcm",
              },
        );
        if (provider === "openrouter")
          expect(JSON.parse(String(init?.body))).not.toHaveProperty("speed");
        expect(yield* service.synthesisModels(provider)).toEqual({
          models:
            provider === "xai"
              ? [{ id: "grok-tts", name: "Grok TTS", voices: ["reader"] }]
              : [
                  { id: "google/gemini-test-tts", name: "Speech", voices: ["reader"] },
                  { id: "minimax/speech-test:free", name: "minimax/speech-test:free", voices: [] },
                ],
        });
        if (provider === "xai") {
          expect(new Headers(upstream.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe(
            "Bearer speech-key",
          );
        }
        if (provider === "openrouter") {
          yield* service.synthesize(provider, { ...request, voice: "" });
          expect(JSON.parse(String(upstream.mock.calls.at(-1)?.[1]?.body)).voice).toBe("reader");
          upstream.mockResolvedValueOnce(
            new Response(Uint8Array.of(0, 1), { headers: { "content-type": "audio/pcm" } }),
          );
          const plainPcm = yield* service.synthesize(provider, {
            ...request,
            model: "google/gemini-tts",
            voice: "reader",
          });
          expect(new DataView(plainPcm.buffer, plainPcm.byteOffset).getUint32(24, true)).toBe(
            24000,
          );
          for (const model of ["minimax/speech-test:free", "mistralai/voxtral-mini-tts-2603"]) {
            upstream.mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51, 1])));
            expect([
              ...(yield* service.synthesize(provider, {
                ...request,
                model,
              })),
            ]).toEqual([73, 68, 51, 1]);
            expect(JSON.parse(String(upstream.mock.calls.at(-1)?.[1]?.body)).response_format).toBe(
              "mp3",
            );
          }
          upstream.mockResolvedValueOnce(
            new Response(new Uint8Array([0, 1]), {
              headers: { "content-type": "audio/pcm;rate=garbage" },
            }),
          );
          expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
            reason: "unavailable",
          });
        }
        upstream.mockResolvedValueOnce(
          new Response("private upstream diagnostic", { status: 429 }),
        );
        expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
          reason: "rate-limit",
        });
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
          expect(
            operation === "catalog"
              ? yield* Effect.flip(service.synthesisModels(provider))
              : yield* Effect.flip(service.synthesize(provider, request)),
          ).toMatchObject({ reason: "unavailable" });
          expect(pulls).toBeLessThan(40);
          expect(cancel).toHaveBeenCalledOnce();
        }
        yield* service.setKey(provider, null);
        const count = upstream.mock.calls.length;
        expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
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

it.effect(
  "uses the native Codex subscription login without an API key and detects auth changes",
  () =>
    Effect.gen(function* () {
      let contents = "{}";
      const read = vi.fn((_path: string) => Effect.sync(() => contents));
      const upstream = vi.fn<typeof fetch>(
        async () =>
          new Response(Uint8Array.of(0xff, 0xf9, 0x58, 0x40), {
            headers: { "content-type": "audio/aac" },
          }),
      );
      const native = (token: string, account = "native-account") =>
        JSON.stringify({ tokens: { access_token: token, account_id: account } });
      const program = Effect.gen(function* () {
        const service = yield* CloudSpeech.CloudSpeech;
        const request = {
          text: "Read this sample.",
          model: "",
          voice: "",
          speed: 1,
          language: "auto",
        };
        for (const invalid of [
          "{}",
          "not-json",
          JSON.stringify({ OPENAI_API_KEY: "api-key", tokens: null }),
          JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "old-token" } }),
        ]) {
          contents = invalid;
          expect(yield* service.synthesisModels("chatgpt")).toEqual({ models: [] });
          expect(yield* Effect.flip(service.synthesize("chatgpt", request))).toMatchObject({
            reason: "subscription-login-required",
          });
        }
        expect(upstream).not.toHaveBeenCalled();
        contents = native("native-token");
        expect(yield* service.synthesisModels("chatgpt")).toEqual({
          models: [{ id: "chatgpt-read-aloud", name: "ChatGPT read aloud", voices: [] }],
        });
        expect(yield* service.synthesize("chatgpt", request)).toEqual(
          Uint8Array.of(0xff, 0xf9, 0x58, 0x40),
        );
        expect(read).toHaveBeenLastCalledWith("/native-codex/auth.json");
        const [url, init] = upstream.mock.calls[0]!;
        expect(String(url)).toBe("https://chatgpt.com/backend-api/read-aloud/synthesize");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer native-token");
        expect(headers.get("ChatGPT-Account-Id")).toBe("native-account");
        expect(init?.redirect).toBe("error");
        expect(JSON.parse(String(init?.body))).toEqual({ text: request.text });
        for (const [status, reason] of [
          [401, "subscription-expired"],
          [403, "subscription-unavailable"],
          [429, "rate-limit"],
        ] as const) {
          upstream.mockResolvedValueOnce(new Response("private diagnostic", { status }));
          const error = yield* Effect.flip(service.synthesize("chatgpt", request));
          expect(error).toMatchObject({ reason });
          expect(error.message).not.toContain("private");
        }
        read.mockReturnValueOnce(Effect.succeed(native("first", "account-one")));
        read.mockReturnValueOnce(Effect.succeed(native("second", "account-two")));
        const count = upstream.mock.calls.length;
        expect(yield* Effect.flip(service.synthesize("chatgpt", request))).toMatchObject({
          reason: "key-changed",
        });
        expect(upstream.mock.calls.length).toBe(count);
      });
      yield* program.pipe(
        Effect.provide(
          CloudSpeech.layer.pipe(
            Layer.provide(FileSystem.layerNoop({ readFileString: read })),
            Layer.provide(Path.layer),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, upstream),
        Effect.provideService(HostProcess.Environment, { CODEX_HOME: "/native-codex" }),
      );
    }),
);

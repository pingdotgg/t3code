import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

it.effect.each(["openai", "xai", "openrouter"] as const)(
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
        yield* service.setKey(
          provider === "openai" ? "xai" : "openai",
          Redacted.make("must-not-be-forwarded"),
        );
        const request = {
          text: "Read this reply.",
          model: provider === "openai" ? "gpt-4o-mini-tts" : "google/gemini-test-tts",
          voice: provider === "openai" ? "alloy" : "reader",
          speed: 1.25,
          language: "en",
        };
        expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
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
            Effect.flip(service.synthesize(provider, { ...request, voice: "" })),
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
            openai: "https://api.openai.com/v1/audio/speech",
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
                response_format: provider === "openai" ? "mp3" : "pcm",
              },
        );
        if (provider === "openrouter")
          expect(JSON.parse(String(init?.body))).not.toHaveProperty("speed");
        else expect(JSON.parse(String(init?.body)).speed).toBe(1.25);
        const catalog = yield* service.synthesisModels(provider);
        expect(catalog).toMatchObject({
          apiKeyProvider: provider,
          defaultModel:
            provider === "openai"
              ? "gpt-4o-mini-tts"
              : provider === "xai"
                ? "grok-tts"
                : "google/gemini-test-tts",
          speedAppliedByProvider: provider !== "openrouter",
          supportsModelSelection: true,
          supportsVoiceSelection: true,
        });
        if (provider === "openai")
          expect(catalog.models.map((model) => model.id)).toEqual([
            "gpt-4o-mini-tts",
            "tts-1",
            "tts-1-hd",
          ]);
        else
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
          yield* service.synthesize(provider, { ...request, voice: "" });
          expect(JSON.parse(String(upstream.mock.calls.at(-1)?.[1]?.body)).voice).toBe("reader");
          for (const [model, expectedRate] of [
            ["google/gemini-tts", 24000],
            ["heygen/heygen-voice-1", 44100],
          ] as const) {
            upstream.mockResolvedValueOnce(
              new Response(Uint8Array.of(0, 1), { headers: { "content-type": "audio/pcm" } }),
            );
            const plainPcm = yield* service.synthesize(provider, {
              ...request,
              model,
              voice: "reader",
            });
            expect(new DataView(plainPcm.buffer, plainPcm.byteOffset).getUint32(24, true)).toBe(
              expectedRate,
            );
          }
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
          for (const contentType of [
            "audio/pcm;rate=garbage",
            "audio/pcm;rate=",
            "audio/pcm;channels=",
          ]) {
            upstream.mockResolvedValueOnce(
              new Response(new Uint8Array([0, 1]), { headers: { "content-type": contentType } }),
            );
            expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
              reason: "unavailable",
            });
          }
        }
        upstream.mockResolvedValueOnce(
          new Response("private upstream diagnostic", { status: 429 }),
        );
        expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
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
        const streamFailure = yield* Effect.flip(service.synthesize(provider, request));
        expect(streamFailure).toHaveProperty("cause");
        expect(streamFailure.message).not.toContain("private stream diagnostic");
        for (const operation of (provider === "openai"
          ? ["synthesis"]
          : ["catalog", "synthesis"]) as ReadonlyArray<"catalog" | "synthesis">) {
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
            expect(yield* Effect.flip(service.synthesize(provider, request))).toMatchObject({
              reason: "unavailable",
            });
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

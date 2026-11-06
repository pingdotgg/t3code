import { it } from "@effect/vitest";
import {
  CloudSpeechProvider,
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SecretProviderId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as CloudSpeech from "./CloudSpeech.ts";

it.effect.each(CloudSpeechProvider.literals)(
  "sends only to %s using its own saved key",
  (provider) =>
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
      expect(yield* service.configured).toEqual({ openai: true, xai: true });
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
      const wav = new DataView(
        yield* Effect.promise(() => (form.get("file") as Blob).arrayBuffer()),
      );
      expect(wav.getUint32(24, true)).toBe(16_000);
      expect(wav.getInt16(46, true)).toBe(16384);
      upstream.mockResolvedValueOnce(
        new Response("sensitive upstream diagnostic", { status: 401 }),
      );
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

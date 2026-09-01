import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  readTranscriptionBody,
  transcribeWithOpenAi,
  validateTranscriptionToken,
  type TranscriptionClaims,
} from "./Transcription.ts";

const claims: TranscriptionClaims = {
  version: 1,
  kind: "transcription",
  mimeType: "audio/mp4",
  sizeBytes: 3,
  locale: "en-US",
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const secretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    remove: () => Effect.void,
  }),
);

const settingsLayer = ServerSettings.layerTest({
  transcription: {
    openAiApiKey: { value: "sk-test", sensitive: true },
    model: "gpt-transcribe",
  },
});

type WebResponse = Parameters<typeof HttpClientResponse.fromWeb>[1];

const clientLayer = (response: WebResponse) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response))),
  );

describe("environment transcription", () => {
  it.effect("rejects malformed signed URLs", () =>
    Effect.gen(function* () {
      assert.isNull(yield* validateTranscriptionToken("not-a-token"));
    }).pipe(Effect.provide(secretStoreLayer)),
  );

  it.effect("buffers the exact signed body size and rejects oversized bodies", () =>
    Effect.gen(function* () {
      const accepted = yield* readTranscriptionBody(
        claims,
        Stream.make(new Uint8Array([1]), new Uint8Array([2, 3])),
      );
      assert.deepEqual(accepted, { ok: true, body: new Uint8Array([1, 2, 3]) });

      const oversized = yield* readTranscriptionBody(
        claims,
        Stream.make(new Uint8Array([1, 2, 3, 4])),
      );
      assert.deepEqual(oversized, {
        ok: false,
        detail: "Body was 4 bytes, expected 3.",
      });
    }),
  );

  it.effect("returns OpenAI transcript text", () =>
    Effect.gen(function* () {
      const result = yield* transcribeWithOpenAi(claims, new Uint8Array([1, 2, 3]));
      assert.deepEqual(result, { ok: true, text: "transcribed text" });
    }).pipe(
      Effect.provide(clientLayer(Response.json({ text: "transcribed text" }) as WebResponse)),
      Effect.provide(settingsLayer),
    ),
  );

  it.effect("maps an OpenAI error to a clear gateway failure", () =>
    Effect.gen(function* () {
      const result = yield* transcribeWithOpenAi(claims, new Uint8Array([1, 2, 3]));
      assert.deepEqual(result, {
        ok: false,
        status: 502,
        detail: "OpenAI transcription failed with status 429.",
      });
    }).pipe(
      Effect.provide(clientLayer(new Response("rate limited", { status: 429 }) as WebResponse)),
      Effect.provide(settingsLayer),
    ),
  );

  it.effect("interrupts the upstream request when the caller disconnects", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const pending = transcribeWithOpenAi(claims, new Uint8Array([1, 2, 3])).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              ),
            ),
          ),
        ),
        Effect.provide(settingsLayer),
      );
      const fiber = yield* Effect.forkChild(pending);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(interrupted);
    }),
  );
});

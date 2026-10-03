import { decodeSpeechPcmRequest } from "@t3tools/shared/speech";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/unstable/http";
import { EnvironmentId, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { transcribeEnvironmentPcm } from "./environment.ts";

const environmentId = Schema.decodeSync(EnvironmentId)("voice-test");
const prepared = (
  httpBaseUrl: string,
  httpAuthorization: PreparedHttpAuthorization | null = null,
): PreparedConnection => ({
  environmentId,
  label: "test",
  httpBaseUrl,
  socketUrl: "ws://localhost/ws",
  httpAuthorization,
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "test",
    httpBaseUrl,
    wsBaseUrl: "ws://localhost",
  }),
});
it.effect.each(["http://remote.example", "http://127.0.0.1.evil.example", "http://192.168.1.1"])(
  "does not send audio or credentials to %s",
  (url) =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () => Response.json({ text: "hello" }));
      const result = yield* transcribeEnvironmentPcm(
        prepared(url),
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result,
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        message: "Voice input requires HTTPS for remote environments.",
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
);
it.effect.each([
  "https://remote.example",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
])("allows protected or loopback transport %s", (url) =>
  Effect.gen(function* () {
    const fetch = vi.fn(async () => Response.json({ text: "hello" }));
    expect(
      yield* transcribeEnvironmentPcm(
        prepared(url),
        new Uint8Array(4),
        DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ).toEqual({ text: "hello" });
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error", credentials: "include" }),
    );
  }),
);

it.effect("does not send browser cookies with bearer-authenticated voice requests", () =>
  Effect.gen(function* () {
    let credentials: RequestCredentials | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      credentials = init?.credentials;
      return Response.json({ text: "hello" });
    });
    yield* transcribeEnvironmentPcm(
      prepared("https://remote.example", { _tag: "Bearer", token: "secret" }),
      new Uint8Array(4),
      DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(credentials).toBeUndefined();
  }),
);

it.effect(
  "sends resolved preferences and project vocabulary to a remote transcription environment",
  () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const decoded = decodeSpeechPcmRequest(
          new Uint8Array(await new Response(init?.body).arrayBuffer()),
        );
        expect(decoded.options).toMatchObject({
          projectName: "T3 Code",
          speechLanguage: "fr",
          speechCustomWords: [{ term: "Effect", aliases: [] }],
        });
        expect(decoded.pcm).toEqual(new Uint8Array(4));
        expect(new Headers(init?.headers).has("x-t3-project-id")).toBe(false);
        return Response.json({ text: "hello" });
      });
      yield* transcribeEnvironmentPcm(prepared("https://remote.example"), new Uint8Array(4), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        projectName: "T3 Code",
        speechLanguage: "fr",
        speechCustomWords: [{ term: "Effect", aliases: [] }],
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      expect(fetch).toHaveBeenCalledOnce();
    }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MAX_VOICE_AUDIO_BYTES,
  normalizeVoiceAudioMimeType,
  voiceAudioFileNameForMimeType,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Option from "effect/Option";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  checkCodexVoiceAvailability,
  requireCodexVoiceProvider,
  resolveCodexVoiceCredentials,
  transcribeCodexVoice,
} from "./VoiceTranscription.ts";

const writeCodexAuth = Effect.fn("VoiceTranscription.test.writeCodexAuth")(function* (
  homePath: string,
  accessToken: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(
    path.join(homePath, "auth.json"),
    `{"tokens":{"access_token":"${accessToken}","account_id":"account-123"}}`,
  );
});

it.layer(NodeServices.layer)("VoiceTranscription", (it) => {
  describe("credentials", () => {
    it.effect("reports unavailable with a login hint when Codex credentials are missing", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "voice-missing-shared-",
        });
        const shadowHome = path.join(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-missing-shadow-root-" }),
          "shadow",
        );
        const settingsLayer = ServerSettingsService.layerTest({
          providers: { codex: { homePath: sharedHome, shadowHomePath: shadowHome } },
        });

        const available = yield* checkCodexVoiceAvailability.pipe(Effect.provide(settingsLayer));
        expect(available).toBe(false);

        const error = yield* Effect.flip(
          resolveCodexVoiceCredentials().pipe(Effect.provide(settingsLayer)),
        );
        expect(error._tag).toBe("EnvironmentHttpForbiddenError");
        expect(error.message).toContain("codex login");
      }),
    );

    it.effect("reads ChatGPT credentials from the shadow home when present", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "voice-shadow-shared-",
        });
        const shadowRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "voice-shadow-root-",
        });
        const shadowHome = path.join(shadowRoot, "shadow");
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* writeCodexAuth(shadowHome, "shadow-token");

        const credentials = yield* resolveCodexVoiceCredentials().pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              providers: { codex: { homePath: sharedHome, shadowHomePath: shadowHome } },
            }),
          ),
        );
        expect(credentials).toEqual({ accessToken: "shadow-token", accountId: "account-123" });
      }),
    );
  });

  describe("provider matrix", () => {
    it.effect("returns explicit unsupported for non-Codex providers", () =>
      Effect.gen(function* () {
        for (const driver of ["claudeAgent", "cursor", "grok", "opencode"]) {
          const error = yield* Effect.flip(requireCodexVoiceProvider(driver));
          expect(error._tag).toBe("VoiceProviderUnsupportedError");
          expect(error.message).toContain("Codex");
          expect(error.message).toContain(driver);
        }
        yield* requireCodexVoiceProvider("codex");
      }),
    );
  });

  describe("transcription", () => {
    it.effect("maps a rejected Codex login to a bounded error without leaking credentials", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "voice-rejected-",
        });
        yield* writeCodexAuth(homePath, "secret-token-abc");

        let calls = 0;
        const rejectedClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              calls += 1;
              return HttpClientResponse.fromWeb(
                request,
                new Response("upstream rejection detail", { status: 401 }),
              );
            }),
          ),
        );

        const error = yield* transcribeCodexVoice(new Uint8Array([1, 2, 3])).pipe(
          Effect.provide(
            Layer.mergeAll(
              rejectedClient,
              ServerSettingsService.layerTest({ providers: { codex: { homePath } } }),
            ),
          ),
          Effect.flip,
        );

        expect(calls).toBe(1);
        expect(error._tag).toBe("EnvironmentHttpForbiddenError");
        expect(error.message).toContain("codex login");
        expect(error.message).not.toContain("secret-token-abc");
        expect(error.message).not.toContain("upstream rejection detail");
      }),
    );

    it.effect("rejects audio over 25 MB before reading credentials or calling upstream", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const emptyHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-cap-" });

        let calls = 0;
        const countingClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              calls += 1;
              return HttpClientResponse.fromWeb(request, Response.json({ text: "unreachable" }));
            }),
          ),
        );

        const error = yield* transcribeCodexVoice(new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1)).pipe(
          Effect.provide(
            Layer.mergeAll(
              countingClient,
              ServerSettingsService.layerTest({ providers: { codex: { homePath: emptyHome } } }),
            ),
          ),
          Effect.flip,
        );

        expect(error._tag).toBe("EnvironmentHttpBadRequestError");
        expect(error.message).toContain("25 MB");
        expect(calls).toBe(0);
      }),
    );

    it.effect("accepts exactly 25 MB and trims the upstream transcript", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-boundary-" });
        yield* writeCodexAuth(homePath, "boundary-token");

        let observedUrl: string | undefined;
        const successClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              observedUrl = request.url;
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ text: "  hello voice  " }),
              );
            }),
          ),
        );

        const result = yield* transcribeCodexVoice(new Uint8Array(MAX_VOICE_AUDIO_BYTES)).pipe(
          Effect.provide(
            Layer.mergeAll(
              successClient,
              ServerSettingsService.layerTest({ providers: { codex: { homePath } } }),
            ),
          ),
        );

        expect(observedUrl).toBe("https://chatgpt.com/backend-api/transcribe");
        expect(result).toEqual({ transcript: "hello voice" });
      }),
    );

    it.effect("aborts the upstream request when transcription is interrupted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-abort-" });
        yield* writeCodexAuth(homePath, "abort-token");

        const entered = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const blockingClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(entered, void 0).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, void 0)),
            ),
          ),
        );

        const fiber = yield* Effect.forkChild(
          transcribeCodexVoice(new Uint8Array([1, 2, 3])).pipe(
            Effect.provide(
              Layer.mergeAll(
                blockingClient,
                ServerSettingsService.layerTest({ providers: { codex: { homePath } } }),
              ),
            ),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(interrupted);
      }),
    );

    it.effect("does not follow redirects with credentials", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-redirect-" });
        yield* writeCodexAuth(homePath, "redirect-token");

        let calls = 0;
        let observedRedirect: string | undefined;
        const redirectClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              calls += 1;
              const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
              observedRedirect = Option.getOrUndefined(init)?.redirect;
              return HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 302,
                  headers: { location: "https://second.example/transcribe" },
                }),
              );
            }),
          ),
        );

        const error = yield* transcribeCodexVoice(new Uint8Array([1, 2, 3])).pipe(
          Effect.provide(
            Layer.mergeAll(
              redirectClient,
              ServerSettingsService.layerTest({ providers: { codex: { homePath } } }),
            ),
          ),
          Effect.flip,
        );

        // Manual redirect mode surfaces 3xx as a failure instead of re-sending
        // the bearer token and ChatGPT-Account-Id to a second origin.
        expect(observedRedirect).toBe("manual");
        expect(calls).toBe(1);
        expect(error._tag).toBe("EnvironmentHttpInternalServerError");
      }),
    );
  });

  describe("audio mime", () => {
    it("normalizes recorder mimes to the upstream set with matching filenames", () => {
      expect(normalizeVoiceAudioMimeType("audio/mp4")).toBe("audio/mp4");
      expect(normalizeVoiceAudioMimeType("audio/mp4;codecs=mp4a.40.2")).toBe("audio/mp4");
      expect(normalizeVoiceAudioMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
      expect(normalizeVoiceAudioMimeType("audio/webm")).toBe("audio/webm");
      expect(normalizeVoiceAudioMimeType(null)).toBe("audio/webm");
      expect(normalizeVoiceAudioMimeType(undefined)).toBe("audio/webm");
      expect(voiceAudioFileNameForMimeType("audio/mp4")).toBe("recording.mp4");
      expect(voiceAudioFileNameForMimeType("audio/webm;codecs=opus")).toBe("recording.webm");
    });

    it.effect("transcribes Safari mp4 audio instead of mislabeling it as webm", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-mp4-" });
        yield* writeCodexAuth(homePath, "mp4-token");

        const successClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() =>
              HttpClientResponse.fromWeb(request, Response.json({ text: "  hola  " })),
            ),
          ),
        );

        const result = yield* transcribeCodexVoice(new Uint8Array([1, 2, 3]), "audio/mp4").pipe(
          Effect.provide(
            Layer.mergeAll(
              successClient,
              ServerSettingsService.layerTest({ providers: { codex: { homePath } } }),
            ),
          ),
        );

        expect(result).toEqual({ transcript: "hola" });
      }),
    );
  });
});

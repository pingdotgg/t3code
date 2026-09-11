/**
 * VoiceTranscription — Codex-native one-shot dictation (Phase 1, desktop-first).
 *
 * Recordings stay in memory from client upload to the upstream request; audio
 * is never written to disk. ChatGPT credentials are read host-side from the
 * first configured Codex home (shadow layout included) and never leave the
 * server: availability exposes one boolean, errors carry bounded hints.
 *
 * @module voice/VoiceTranscription
 */
import {
  CodexSettings,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  MAX_VOICE_AUDIO_BYTES,
  normalizeVoiceAudioMimeType,
  voiceAudioFileNameForMimeType,
  VoiceProviderUnsupportedError,
  voiceUnsupportedMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Private Codex Desktop transcription endpoint (experimental, undocumented). */
export const CODEX_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

const CODEX_TRANSCRIBE_TIMEOUT = "2 minutes" as const;

/** Codex Desktop identity headers. No language hint: the endpoint auto-detects. */
const CODEX_DESKTOP_HEADERS = {
  originator: "Codex Desktop",
  "User-Agent": "Codex Desktop/0.1.0",
  "OAI-Product-Sku": "CODEX",
} as const;

export interface CodexVoiceCredentials {
  readonly accessToken: string;
  readonly accountId: string;
}

const CodexVoiceAuthFile = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.NonEmptyString,
    account_id: Schema.NonEmptyString,
  }),
});
const decodeCodexVoiceAuthFile = Schema.decodeEffect(Schema.fromJsonString(CodexVoiceAuthFile));
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const CodexTranscribeResponse = Schema.Struct({ text: Schema.String });

/** Bounded 403 hinting at `codex login`; never embeds token material. */
const voiceAuthUnavailable = () =>
  new EnvironmentHttpForbiddenError({
    message: "Codex voice is unavailable. Run `codex login` with ChatGPT and try again.",
  });

/** Reads file-based ChatGPT credentials from the first configured Codex home. */
export const resolveCodexVoiceCredentials = Effect.fn(
  "VoiceTranscription.resolveCodexVoiceCredentials",
)(function* () {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      () => new EnvironmentHttpInternalServerError({ message: "Voice transcription failed." }),
    ),
  );
  const instances = Object.values(deriveProviderInstanceConfigMap(settings));
  const codexInstance = instances.find((instance) => instance.driver === "codex");
  if (!codexInstance) {
    return yield* new VoiceProviderUnsupportedError({
      message: voiceUnsupportedMessage(instances.map((instance) => instance.driver)),
    });
  }
  const config = yield* decodeCodexSettings(codexInstance.config ?? {}).pipe(
    Effect.mapError(() => voiceAuthUnavailable()),
  );
  const layout = yield* resolveCodexHomeLayout(config);
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const authPath = path.join(layout.effectiveHomePath ?? layout.sharedHomePath, "auth.json");
  const encoded = yield* fileSystem
    .readFileString(authPath)
    .pipe(Effect.mapError(() => voiceAuthUnavailable()));
  const auth = yield* decodeCodexVoiceAuthFile(encoded).pipe(
    Effect.mapError(() => voiceAuthUnavailable()),
  );
  return {
    accessToken: auth.tokens.access_token,
    accountId: auth.tokens.account_id,
  } satisfies CodexVoiceCredentials;
});

/** Explicit v1 provider matrix: Codex only, everything else is unsupported (not hidden). */
export const requireCodexVoiceProvider = Effect.fn("VoiceTranscription.requireCodexVoiceProvider")(
  function* (driver: string) {
    if (driver !== "codex") {
      return yield* new VoiceProviderUnsupportedError({
        message: voiceUnsupportedMessage([driver]),
      });
    }
  },
);

const forwardToCodexTranscription = Effect.fn("VoiceTranscription.forwardToCodexTranscription")(
  function* (audio: Uint8Array, mimeType: string, credentials: CodexVoiceCredentials) {
    const normalizedMime = normalizeVoiceAudioMimeType(mimeType);
    const form = new FormData();
    form.append(
      "file",
      new Blob([audio], { type: normalizedMime }),
      voiceAudioFileNameForMimeType(normalizedMime),
    );
    const httpClient = yield* HttpClient.HttpClient;
    const completed = yield* HttpClientRequest.post(CODEX_TRANSCRIBE_URL, {
      body: HttpBody.formData(form),
    }).pipe(
      HttpClientRequest.bearerToken(credentials.accessToken),
      HttpClientRequest.setHeader("ChatGPT-Account-Id", credentials.accountId),
      HttpClientRequest.setHeaders(CODEX_DESKTOP_HEADERS),
      httpClient.execute,
      Effect.mapError(
        () => new EnvironmentHttpInternalServerError({ message: "Voice transcription failed." }),
      ),
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status === 401 || response.status === 403) {
            return yield* new EnvironmentHttpForbiddenError({
              message:
                "Codex rejected the voice request. Run `codex login` with ChatGPT and try again.",
            });
          }
          if (response.status < 200 || response.status >= 300) {
            return yield* new EnvironmentHttpInternalServerError({
              message: "Voice transcription failed.",
            });
          }
          return yield* HttpClientResponse.schemaBodyJson(CodexTranscribeResponse)(response).pipe(
            Effect.mapError(
              () =>
                new EnvironmentHttpInternalServerError({ message: "Voice transcription failed." }),
            ),
          );
        }),
      ),
      Effect.timeoutOption(CODEX_TRANSCRIBE_TIMEOUT),
    );
    if (Option.isNone(completed)) {
      return yield* new EnvironmentHttpInternalServerError({
        message: "Voice transcription timed out.",
      });
    }
    return { transcript: completed.value.text.trim() };
  },
);

/** Validates one-shot audio in memory, then transcribes via the Codex subscription. */
export const transcribeCodexVoice = Effect.fn("VoiceTranscription.transcribeCodexVoice")(function* (
  audio: Uint8Array,
  mimeType?: string | null,
) {
  if (audio.byteLength === 0) {
    return yield* new EnvironmentHttpBadRequestError({ message: "The recording is empty." });
  }
  if (audio.byteLength > MAX_VOICE_AUDIO_BYTES) {
    return yield* new EnvironmentHttpBadRequestError({
      message: "The recording exceeds the 25 MB voice input limit.",
    });
  }
  const credentials = yield* resolveCodexVoiceCredentials();
  return yield* forwardToCodexTranscription(audio, mimeType ?? "audio/webm", credentials);
});

/** Availability probe: false for missing/rejected file login, never token material. */
export const checkCodexVoiceAvailability = resolveCodexVoiceCredentials().pipe(
  Effect.as(true),
  Effect.catchTags({
    VoiceProviderUnsupportedError: () => Effect.succeed(false),
    EnvironmentHttpForbiddenError: () => Effect.succeed(false),
  }),
);

import {
  CodexSettings,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
export const CODEX_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

const CODEX_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CODEX_TRANSCRIPTION_HEADERS = {
  "X-OpenAI-Attach-Auth": "1",
  "X-OpenAI-Attach-Integrity-State": "1",
  "x-codex-base64": "1",
  originator: "Codex Desktop",
  "User-Agent": CODEX_BROWSER_USER_AGENT,
  "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not=A?Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "oai-did": NodeCrypto.randomUUID(),
  "OAI-Language": "en",
  Origin: "https://chatgpt.com",
  Referer: "https://chatgpt.com/",
} as const;

const CodexVoiceAuth = Schema.Struct({
  auth_mode: Schema.Literal("chatgpt"),
  tokens: Schema.Struct({
    access_token: Schema.NonEmptyString,
    account_id: Schema.NonEmptyString,
  }),
});

const CodexTranscriptionResponse = Schema.Struct({
  text: Schema.String,
});
const decodeCodexVoiceAuth = Schema.decodeEffect(Schema.fromJsonString(CodexVoiceAuth));
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

interface CodexVoiceCredentials {
  readonly accessToken: string;
  readonly accountId: string;
}

export const readCodexVoiceCredentials = Effect.fn("VoiceTranscription.readCodexVoiceCredentials")(
  function* (config: CodexSettings) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const layout = yield* resolveCodexHomeLayout(config);
    const authPath = path.join(layout.effectiveHomePath ?? layout.sharedHomePath, "auth.json");
    const encoded = yield* fileSystem.readFileString(authPath).pipe(
      Effect.mapError(
        () =>
          new EnvironmentHttpForbiddenError({
            message: "Codex OAuth credentials are unavailable.",
          }),
      ),
    );
    const auth = yield* decodeCodexVoiceAuth(encoded).pipe(
      Effect.mapError(
        () =>
          new EnvironmentHttpForbiddenError({
            message: "Voice input requires a Codex ChatGPT OAuth login.",
          }),
      ),
    );
    return {
      accessToken: auth.tokens.access_token,
      accountId: auth.tokens.account_id,
    } satisfies CodexVoiceCredentials;
  },
);

const extensionForMimeType = (mimeType: string): string => {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
};

export const transcribeCodexAudio = Effect.fn("VoiceTranscription.transcribeCodexAudio")(
  function* (input: {
    readonly credentials: CodexVoiceCredentials;
    readonly audio: Uint8Array;
    readonly mimeType: string;
  }) {
    if (input.audio.byteLength === 0) {
      return yield* new EnvironmentHttpBadRequestError({ message: "The recording is empty." });
    }
    if (input.audio.byteLength > MAX_VOICE_AUDIO_BYTES) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "The recording exceeds the 25 MB voice input limit.",
      });
    }
    if (!/^(audio|video)\//u.test(input.mimeType)) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "The recording has an unsupported media type.",
      });
    }

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([input.audio], { type: input.mimeType }),
      `recording.${extensionForMimeType(input.mimeType)}`,
    );
    const httpClient = yield* HttpClient.HttpClient;
    return yield* HttpClientRequest.post(CODEX_TRANSCRIBE_URL, {
      body: HttpBody.formData(formData),
    }).pipe(
      HttpClientRequest.bearerToken(input.credentials.accessToken),
      HttpClientRequest.setHeader("ChatGPT-Account-Id", input.credentials.accountId),
      HttpClientRequest.setHeaders(CODEX_TRANSCRIPTION_HEADERS),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CodexTranscriptionResponse)),
      Effect.mapError(
        () => new EnvironmentHttpInternalServerError({ message: "Voice transcription failed." }),
      ),
    );
  },
);

export const transcribeVoice = Effect.fn("VoiceTranscription.transcribe")(function* (input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly audio: Uint8Array;
  readonly mimeType: string;
}) {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      () => new EnvironmentHttpInternalServerError({ message: "Voice transcription failed." }),
    ),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[input.providerInstanceId];
  if (!instance || instance.driver !== "codex") {
    return yield* new EnvironmentHttpForbiddenError({
      message: "Voice input requires a Codex provider instance.",
    });
  }
  const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
    Effect.mapError(
      () =>
        new EnvironmentHttpForbiddenError({
          message: "The selected Codex provider configuration is invalid.",
        }),
    ),
  );
  const credentials = yield* readCodexVoiceCredentials(config);
  return yield* transcribeCodexAudio({ ...input, credentials });
});

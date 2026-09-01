import {
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_URL_TTL_MS,
  type TranscriptionCreateUrlInput,
  TranscriptionResponse,
  TranscriptionSigningKeyError,
  TranscriptionUnavailableError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";

export const TRANSCRIPTION_ROUTE_PREFIX = "/api/transcription";
const SIGNING_SECRET_NAME = "transcription-signing-key";
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";

const TranscriptionClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("transcription"),
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  locale: Schema.String,
  expiresAt: Schema.Number,
});
export type TranscriptionClaims = typeof TranscriptionClaims.Type;

const claimsJson = Schema.fromJsonString(TranscriptionClaims);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);
const encodeClaims = Schema.encodeSync(claimsJson);

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export const transcriptionServicesForSettings = (settings: {
  readonly transcription: { readonly openAiApiKey: { readonly value: string } };
}) =>
  settings.transcription.openAiApiKey.value.length > 0
    ? ([{ id: "openai", label: "OpenAI" }] as const)
    : [];

export const issueTranscriptionUrl = Effect.fn("Transcription.issueUrl")(function* (
  input: TranscriptionCreateUrlInput,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  if ((yield* settings.getSettings).transcription.openAiApiKey.value.length === 0) {
    return yield* new TranscriptionUnavailableError({});
  }
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError((cause) => new TranscriptionSigningKeyError({ cause })),
  );
  const expiresAt = (yield* Clock.currentTimeMillis) + TRANSCRIPTION_URL_TTL_MS;
  const encoded = base64UrlEncode(
    encodeClaims({ version: 1, kind: "transcription", ...input, expiresAt }),
  );
  return {
    relativeUrl: `${TRANSCRIPTION_ROUTE_PREFIX}/${encoded}.${signPayload(encoded, secret)}`,
    expiresAt,
  };
});

export const validateTranscriptionToken = Effect.fn("Transcription.validateToken")(function* (
  token: string,
) {
  const [encoded, signature, unexpected] = token.split(".");
  if (!encoded || !signature || unexpected) return null;
  const secret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null));
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encoded, secret))) return null;
  const claims = Option.getOrNull(decodeClaims(base64UrlDecodeUtf8(encoded)));
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});

export type ReadTranscriptionBodyResult =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly detail: string };

export const readTranscriptionBody = Effect.fn("Transcription.readBody")(function* (
  claims: TranscriptionClaims,
  stream: Stream.Stream<Uint8Array, unknown>,
) {
  const chunks: Uint8Array[] = [];
  let received = 0;
  const result = yield* Stream.runForEach(stream, (chunk) => {
    received += chunk.byteLength;
    if (received > claims.sizeBytes) return Effect.fail("oversized" as const);
    chunks.push(chunk);
    return Effect.void;
  }).pipe(Effect.exit);
  if (received !== claims.sizeBytes) {
    return {
      ok: false,
      detail: `Body was ${received} bytes, expected ${claims.sizeBytes}.`,
    } as const;
  }
  if (result._tag === "Failure") {
    return { ok: false, detail: "Failed to read transcription audio." } as const;
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body } as const;
});

export type OpenAiTranscriptionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly status: number; readonly detail: string };

export const transcribeWithOpenAi = Effect.fn("Transcription.transcribeWithOpenAi")(function* (
  claims: TranscriptionClaims,
  audio: Uint8Array,
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  const apiKey = settings.transcription.openAiApiKey.value;
  if (apiKey.length === 0) {
    return {
      ok: false,
      status: 503,
      detail: "Transcription is not configured.",
    } satisfies OpenAiTranscriptionResult;
  }

  const form = new FormData();
  form.append("file", new Blob([audio], { type: claims.mimeType }), "audio.m4a");
  form.append("model", settings.transcription.model || DEFAULT_OPENAI_TRANSCRIPTION_MODEL);
  const language = claims.locale.split(/[-_]/, 1)[0];
  if (language) form.append("language", language);

  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .post(OPENAI_TRANSCRIPTION_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      body: HttpBody.formData(form),
    })
    .pipe(Effect.exit);
  if (response._tag === "Failure") {
    return {
      ok: false,
      status: 502,
      detail: "OpenAI transcription request failed.",
    } satisfies OpenAiTranscriptionResult;
  }
  if (response.value.status < 200 || response.value.status >= 300) {
    return {
      ok: false,
      status: 502,
      detail: `OpenAI transcription failed with status ${response.value.status}.`,
    } satisfies OpenAiTranscriptionResult;
  }
  const decoded = yield* HttpClientResponse.schemaBodyJson(TranscriptionResponse)(
    response.value,
  ).pipe(Effect.exit);
  if (decoded._tag === "Failure") {
    return {
      ok: false,
      status: 502,
      detail: "OpenAI returned an invalid transcription response.",
    } satisfies OpenAiTranscriptionResult;
  }
  return { ok: true, text: decoded.value.text } satisfies OpenAiTranscriptionResult;
});

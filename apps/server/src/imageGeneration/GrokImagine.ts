// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import {
  type EditImageInput,
  type GenerateImageInput,
  type GrokImageModel,
  ImageGenerationUnavailableError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const GrokAuthEntry = Schema.Struct({
  key: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.String),
  oidc_client_id: Schema.optional(Schema.String),
  oidc_issuer: Schema.optional(Schema.String),
});
const GrokAuthFile = Schema.Record(Schema.String, GrokAuthEntry);
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(GrokAuthFile));

const ImagineResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      b64_json: Schema.optional(Schema.String),
      mime_type: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
  ),
});
const TokenRefreshResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});

export interface GrokImagineRequest {
  readonly prompt: string;
  readonly model: GrokImageModel;
  readonly aspectRatio: string;
  readonly resolution: "1k" | "2k";
  readonly quality?: "auto" | "low" | "medium" | "high";
  readonly sourceImage?: Uint8Array;
}

export interface GrokImagineImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

const unavailable = (detail: string) =>
  new ImageGenerationUnavailableError({
    reason: "provider-unavailable",
    provider: "grok",
    detail,
  });

const providerError = (detail: string) =>
  new ImageGenerationUnavailableError({
    reason: "provider-error",
    provider: "grok",
    detail,
  });

const readAuthEntry = Effect.fn("GrokImagine.readAuthEntry")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authPath = path.join(NodeOS.homedir(), ".grok", "auth.json");
  const encoded = yield* fileSystem
    .readFileString(authPath)
    .pipe(
      Effect.mapError(() => unavailable("Grok is not signed in. Run grok login, then try again.")),
    );
  const parsed = yield* decodeAuthFile(encoded).pipe(
    Effect.mapError(() =>
      unavailable("Could not read the Grok login. Run grok login, then try again."),
    ),
  );
  const entry = Object.values(parsed)[0];
  if (!entry?.key) {
    return yield* unavailable("Grok is not signed in. Run grok login, then try again.");
  }
  return entry;
});

const tokenIsFresh = (expiresAt: string | undefined, nowMs: number): boolean => {
  if (!expiresAt) return true;
  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) return true;
  return expiresMs - nowMs > 60_000;
};

const refreshAccessToken = Effect.fn("GrokImagine.refreshAccessToken")(function* (
  entry: typeof GrokAuthEntry.Type,
) {
  if (!entry.refresh_token || !entry.oidc_client_id) {
    return entry.key;
  }
  const issuer = (entry.oidc_issuer ?? "https://auth.x.ai").replace(/\/$/, "");
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(`${issuer}/oauth/token`).pipe(
    HttpClientRequest.bodyUrlParams({
      grant_type: "refresh_token",
      refresh_token: entry.refresh_token,
      client_id: entry.oidc_client_id,
    }),
    httpClient.execute,
    Effect.mapError(() => providerError("Could not refresh the Grok login.")),
  );
  if (response.status < 200 || response.status >= 300) {
    return entry.key;
  }
  const refreshed = yield* HttpClientResponse.schemaBodyJson(TokenRefreshResponse)(response).pipe(
    Effect.mapError(() => providerError("Could not refresh the Grok login.")),
  );
  return refreshed.access_token;
});

const resolveBearer = Effect.fn("GrokImagine.resolveBearer")(function* () {
  const entry = yield* readAuthEntry();
  const nowMs = yield* Clock.currentTimeMillis;
  if (tokenIsFresh(entry.expires_at, nowMs)) {
    return entry.key;
  }
  return yield* refreshAccessToken(entry);
});

const postImagine = Effect.fn("GrokImagine.post")(function* (
  path: "/images/generations" | "/images/edits",
  payload: Record<string, unknown>,
  token: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(`https://api.x.ai/v1${path}`).pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(httpClient.execute),
    Effect.mapError(() => providerError("Grok Imagine did not respond.")),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* providerError(`Grok Imagine failed (${response.status}).`);
  }
  return yield* HttpClientResponse.schemaBodyJson(ImagineResponse)(response).pipe(
    Effect.mapError(() =>
      providerError("Grok Imagine returned a response T3 Code could not parse."),
    ),
  );
});

const decodeImage = (
  response: typeof ImagineResponse.Type,
): Effect.Effect<GrokImagineImage, ImageGenerationUnavailableError> => {
  const first = response.data[0];
  const b64 = first?.b64_json;
  if (!b64) {
    return Effect.fail(providerError("Grok Imagine returned no image data."));
  }
  return Effect.fromResult(Encoding.decodeBase64(b64)).pipe(
    Effect.mapError(() =>
      providerError("Grok Imagine returned image data T3 Code could not decode."),
    ),
    Effect.map((bytes) => ({
      bytes,
      mimeType: first.mime_type?.trim() || "image/jpeg",
    })),
  );
};

export const generateGrokImage = Effect.fn("GrokImagine.generate")(function* (
  request: GrokImagineRequest,
) {
  const token = yield* resolveBearer();
  const payload: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    response_format: "b64_json",
  };
  if (request.quality && request.quality !== "auto") {
    payload.quality = request.quality;
  }
  const response = yield* postImagine("/images/generations", payload, token);
  return yield* decodeImage(response);
});

export const editGrokImage = Effect.fn("GrokImagine.edit")(function* (
  request: GrokImagineRequest & { readonly sourceImage: Uint8Array },
) {
  const token = yield* resolveBearer();
  const payload: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    response_format: "b64_json",
    image: {
      url: `data:image/jpeg;base64,${Encoding.encodeBase64(request.sourceImage)}`,
    },
  };
  if (request.quality && request.quality !== "auto") {
    payload.quality = request.quality;
  }
  const response = yield* postImagine("/images/edits", payload, token);
  return yield* decodeImage(response);
});

export const grokImagineOptionsFromToolInput = (
  input: GenerateImageInput | EditImageInput,
): { aspectRatio: string; resolution: "1k" | "2k"; quality?: GrokImagineRequest["quality"] } => ({
  aspectRatio: input.aspectRatio ?? "auto",
  resolution: input.resolution ?? "1k",
  ...(input.quality ? { quality: input.quality } : {}),
});

import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  ServerAuthDpopReplayKeyCalculationError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthInvalidCredentialError,
  type ServerAuthInternalError,
} from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

export function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstHeaderValue(request.headers.host) ?? "127.0.0.1";
    const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
    const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : "http";
    return new URL(request.originalUrl, `${proto}://${host}`).href;
  }
}

export const mapDpopReplayStoreError = (
  error: ServerSecretStore.SecretStoreError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError =>
  ServerSecretStore.isSecretAlreadyExistsError(error)
    ? new ServerAuthInvalidCredentialError({
        diagnostic: "DPoP proof replayed.",
        cause: error,
      })
    : new ServerAuthDpopReplayStateRecordError({
        cause: error,
      });

export const verifyRequestDpopProof = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
}) =>
  Effect.gen(function* () {
    const proof = input.request.headers.dpop;
    const now = yield* DateTime.now;
    const result = verifyDpopProof({
      proof,
      method: input.request.method,
      url: requestAbsoluteUrl(input.request),
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
      ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
    });
    if (!result.ok) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: result.reason,
      });
    }
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const replayKey = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) =>
        crypto.digest("SHA-256", new TextEncoder().encode(`${result.thumbprint}:${result.jti}`)),
      ),
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError(
        (cause) =>
          new ServerAuthDpopReplayKeyCalculationError({
            cause,
          }),
      ),
    );
    yield* secretStore
      .create(
        `dpop-proof-${replayKey}`,
        new TextEncoder().encode(
          [
            `thumbprint=${result.thumbprint}`,
            `jti=${result.jti}`,
            `iat=${result.iat}`,
            `consumedAt=${DateTime.formatIso(now)}`,
          ].join("\n"),
        ),
      )
      .pipe(
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          Effect.fail(mapDpopReplayStoreError(error)),
        ),
      );
    return result.thumbprint;
  });

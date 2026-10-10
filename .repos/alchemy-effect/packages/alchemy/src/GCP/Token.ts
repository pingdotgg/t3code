import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as NodeCrypto from "node:crypto";
import { AuthError } from "../Auth/AuthProvider.ts";

export interface ServiceAccountKey {
  readonly type?: string;
  readonly project_id?: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

export interface MintedToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly expirationMs: number;
  readonly project?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const signJwt = (sa: ServiceAccountKey, nowMs: number): string => {
  const now = Math.floor(nowMs / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: sa.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: sa.token_uri ?? TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = NodeCrypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(sa.private_key, "base64url")}`;
};

/**
 * Exchange a service-account JSON key for an OAuth2 access token.
 * Distilled GCP only accepts a bearer token, so Alchemy mints and refreshes
 * it here.
 */
export const mintAccessToken = (
  sa: ServiceAccountKey,
): Effect.Effect<MintedToken, AuthError> =>
  Effect.gen(function* () {
    const issuedAt = yield* Clock.currentTimeMillis;
    const jwt = yield* Effect.try({
      try: () => signJwt(sa, issuedAt),
      catch: (cause) =>
        new AuthError({
          message: "Failed to sign Google service-account JWT",
          cause,
        }),
    });
    const http = yield* HttpClient.HttpClient;
    const tokenResponse = yield* http
      .execute(
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: jwt,
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Failed to mint Google access token",
              cause,
            }),
        ),
      );
    const body = yield* tokenResponse.json.pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Google token response was not JSON",
            cause,
          }),
      ),
    );
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { access_token?: unknown }).access_token !== "string"
    ) {
      return yield* new AuthError({
        message: `Google token endpoint returned no access_token: ${JSON.stringify(body)}`,
      });
    }
    const expiresIn =
      typeof (body as { expires_in?: unknown }).expires_in === "number"
        ? (body as { expires_in: number }).expires_in
        : 3600;
    return {
      accessToken: Redacted.make(
        (body as { access_token: string }).access_token,
      ),
      expirationMs: issuedAt + expiresIn * 1000,
      project: sa.project_id,
    };
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const parseServiceAccountKey = (
  raw: string,
): Effect.Effect<ServiceAccountKey, AuthError> =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(raw) as ServiceAccountKey;
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error("JSON is missing client_email or private_key");
      }
      return parsed;
    },
    catch: (cause) =>
      new AuthError({
        message: "Invalid Google service-account JSON",
        cause,
      }),
  });

import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/**
 * Verification of the Google-signed OIDC ID tokens that Pub/Sub push
 * subscriptions and Cloud Scheduler attach to requests they deliver to a
 * Cloud Run service or Cloud Function. Cloud Run only enforces them when
 * the service requires authentication, so event sources verify every
 * delivery themselves: public services stay safe, and a token minted for
 * one subscription cannot be replayed against another path.
 *
 * NOT exported from `index.ts`.
 */

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface Claims {
  iss?: string;
  aud?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  iat?: number;
}

/**
 * Google's signing keys could not be fetched or imported. Deliveries should
 * be retried (answer 5xx), not rejected as unauthorized.
 */
export class GoogleSigningKeysUnavailable extends Data.TaggedError(
  "GCP.GoogleSigningKeysUnavailable",
)<{ message: string }> {}

const keysUnavailable = (cause: unknown) =>
  new GoogleSigningKeysUnavailable({ message: String(cause) });

let certs: { keys: Map<string, CryptoKey>; fetchedAt: number } | undefined;

/** A JWT segment's JSON, or `undefined` when it isn't valid base64url JSON. */
const decodeSegment = (segment: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(segment)));
  } catch {
    return undefined;
  }
};

const base64UrlBytes = (segment: string): Uint8Array<ArrayBuffer> => {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const loadKeys = (http: HttpClient.HttpClient, force: boolean) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (!force && certs !== undefined && now - certs.fetchedAt < 3_600_000) {
      return certs.keys;
    }
    const response = yield* http
      .execute(HttpClientRequest.get(CERTS_URL))
      .pipe(Effect.mapError(keysUnavailable));
    const body = (yield* response.json.pipe(
      Effect.mapError(keysUnavailable),
    )) as { keys?: Jwk[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA") continue;
      const key = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "jwk",
            { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          ),
        catch: keysUnavailable,
      });
      keys.set(jwk.kid, key);
    }
    certs = { keys, fetchedAt: now };
    return keys;
  });

/**
 * True when `authorization` carries a valid Google ID token for `audience`
 * whose verified email is `email`. A malformed, expired, mis-addressed, or
 * badly signed token is `false`; failing to load Google's signing keys is a
 * {@link GoogleSigningKeysUnavailable} error, so callers can ask the sender
 * to retry.
 */
export const verifyGoogleIdToken = (options: {
  authorization: string | undefined;
  audience: string;
  email: string;
}) =>
  Effect.gen(function* () {
    const token = /^Bearer\s+(.+)$/i.exec(options.authorization ?? "")?.[1];
    if (token === undefined) return false;
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return false;
    const { kid, alg } = (decodeSegment(header) ?? {}) as {
      kid?: string;
      alg?: string;
    };
    if (alg !== "RS256" || kid === undefined) return false;
    const claims = decodeSegment(payload) as Claims | undefined;
    if (claims === undefined) return false;
    let signatureBytes: Uint8Array<ArrayBuffer>;
    try {
      signatureBytes = base64UrlBytes(signature);
    } catch {
      return false;
    }

    const http = yield* HttpClient.HttpClient;
    let key = (yield* loadKeys(http, false)).get(kid);
    // Google rotates signing keys; refetch once for an unknown `kid`.
    if (key === undefined) key = (yield* loadKeys(http, true)).get(kid);
    if (key === undefined) return false;
    const valid = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          signatureBytes,
          new TextEncoder().encode(`${header}.${payload}`),
        ),
      catch: keysUnavailable,
    });
    if (!valid) return false;

    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return (
      ISSUERS.has(claims.iss ?? "") &&
      claims.aud === options.audience &&
      claims.email === options.email &&
      claims.email_verified === true &&
      (claims.exp ?? 0) + CLOCK_SKEW_SECONDS > now &&
      (claims.iat ?? Number.POSITIVE_INFINITY) - CLOCK_SKEW_SECONDS <= now
    );
  });

/** The `aud` claim of a bearer token, unverified — for diagnostics only. */
export const unverifiedAudience = (authorization: string | undefined) => {
  try {
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
    const payload = token?.split(".")[1];
    return payload ? (decodeSegment(payload) as Claims).aud : undefined;
  } catch {
    return undefined;
  }
};

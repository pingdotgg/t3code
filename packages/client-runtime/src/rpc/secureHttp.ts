import type { EnvironmentId } from "@t3tools/contracts";
import {
  makeSecureHttpClientSession,
  SECURE_HTTP_KEY_PATH,
  SECURE_HTTP_PATH,
  SECURE_HTTP_STALE_KEY_STATUS,
  SecureHttpKey,
  type SecureHttpClientSession,
  type SecureHttpInnerResponse,
  verifySecureHttpKey,
} from "@t3tools/shared/secureHttp";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import type * as Aead from "effect/crypto/Aead";
import type * as Digest from "effect/crypto/Digest";
import type * as Kdf from "effect/crypto/Kdf";
import type * as KeyAgreement from "effect/crypto/KeyAgreement";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type * as Persistence from "../platform/persistence.ts";
import type * as ManagedRelay from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "./http.ts";

/** How long one ephemeral key pair serves requests before the next request makes a new one. */
const CLIENT_SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const decodeSecureHttpKey = Schema.decodeUnknownEffect(SecureHttpKey);

class SecureHttpFailure extends Schema.TaggedError<SecureHttpFailure>()("SecureHttpFailure", {
  description: Schema.String,
  /** The exchange key was not signed by the pinned identity key. */
  keyRejected: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

const isRemoteFetchError = Schema.is(RemoteEnvironmentAuthFetchError);
const isSecureHttpFailure = Schema.is(SecureHttpFailure);

/**
 * True when a sealed request failed because the environment presented an exchange key its pinned
 * identity did not sign: the same verdict as a changed key on the secure RPC socket.
 */
export const isSecureHttpKeyRejection = (error: unknown): boolean => {
  if (!isRemoteFetchError(error) || !HttpClientError.isHttpClientError(error.cause)) return false;
  const reason = error.cause.reason;
  return (
    reason._tag === "TransportError" &&
    isSecureHttpFailure(reason.cause) &&
    reason.cause.keyRejected === true
  );
};

export type SecureHttpCrypto =
  | Aead.Aead
  | Digest.Digest
  | Kdf.Kdf
  | KeyAgreement.KeyAgreement
  | SecureRandom.SecureRandom;

export interface SealedEnvironment {
  readonly environmentId: string;
  /** The environment's raw 32-byte Ed25519 identity key. */
  readonly pinnedKey: Uint8Array;
}

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const requestBody = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body;
  if (body._tag === "Empty") return Effect.succeed(new Uint8Array(0));
  if (body._tag === "Uint8Array") return Effect.succeed(body.body);
  if (body._tag === "Raw" && typeof body.body === "string") {
    return Effect.succeed(new TextEncoder().encode(body.body));
  }
  return Effect.fail(
    new SecureHttpFailure({ description: `A ${body._tag} request body cannot be sealed.` }),
  );
};

/**
 * Seals whole requests for environments with a pinned identity key. Verified exchange keys and the
 * ephemeral key pair are kept in memory per environment, so a steady stream of requests costs no
 * key agreement.
 */
export const makeSecureHttpSealer = (crypto: Context.Context<SecureHttpCrypto>) => {
  const exchangeKeys = new Map<
    string,
    {
      readonly pinnedKey: Uint8Array;
      readonly load: Effect.Effect<Uint8Array, SecureHttpFailure>;
    }
  >();
  const sessions = new Map<
    string,
    { readonly session: SecureHttpClientSession; readonly expiresAt: number }
  >();

  const fetchExchangeKey = (
    client: HttpClient.HttpClient,
    origin: URL,
    environment: SealedEnvironment,
  ) =>
    client.get(new URL(SECURE_HTTP_KEY_PATH, origin)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeSecureHttpKey),
      Effect.mapError(
        (cause) =>
          new SecureHttpFailure({ description: "Could not fetch the exchange key.", cause }),
      ),
      Effect.flatMap((key) => {
        const publicKey = verifySecureHttpKey({
          pinned: environment.pinnedKey,
          environmentId: environment.environmentId,
          key,
        });
        return publicKey === undefined
          ? Effect.fail(
              new SecureHttpFailure({
                description: "The exchange key is not signed by the pinned identity key.",
                keyRejected: true,
              }),
            )
          : Effect.succeed(publicKey);
      }),
    );

  const exchangeKey = Effect.fnUntraced(function* (
    client: HttpClient.HttpClient,
    origin: URL,
    environment: SealedEnvironment,
    refresh: boolean,
  ) {
    const cached = exchangeKeys.get(environment.environmentId);
    if (!refresh && cached !== undefined && sameBytes(cached.pinnedKey, environment.pinnedKey)) {
      return yield* cached.load;
    }
    const load = yield* Effect.cached(fetchExchangeKey(client, origin, environment));
    exchangeKeys.set(environment.environmentId, { pinnedKey: environment.pinnedKey, load });
    return yield* load.pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (exchangeKeys.get(environment.environmentId)?.load === load) {
            exchangeKeys.delete(environment.environmentId);
          }
        }),
      ),
    );
  });

  const sessionFor = Effect.fnUntraced(function* (
    client: HttpClient.HttpClient,
    origin: URL,
    environment: SealedEnvironment,
    refresh: boolean,
  ) {
    const exchangePublicKey = yield* exchangeKey(client, origin, environment, refresh);
    const now = yield* Clock.currentTimeMillis;
    const current = sessions.get(environment.environmentId);
    if (
      current !== undefined &&
      current.expiresAt > now &&
      sameBytes(current.session.exchangePublicKey, exchangePublicKey)
    ) {
      return current.session;
    }
    const session = yield* makeSecureHttpClientSession(exchangePublicKey).pipe(
      Effect.mapError(
        (cause) => new SecureHttpFailure({ description: "Could not start sealing.", cause }),
      ),
    );
    sessions.set(environment.environmentId, {
      session,
      expiresAt: now + CLIENT_SESSION_LIFETIME_MS,
    });
    return session;
  });

  return (client: HttpClient.HttpClient, environment: SealedEnvironment): HttpClient.HttpClient =>
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body = yield* requestBody(request);
        const headers: Record<string, string> = { ...request.headers };
        if ("contentType" in request.body && request.body.contentType !== undefined) {
          headers["content-type"] = request.body.contentType;
        }
        const inner = { method: request.method, url: url.toString(), headers, body };
        const sealedUrl = new URL(SECURE_HTTP_PATH, url);
        // A restarted environment no longer has the key: refetch and verify it, then retry once.
        const attempt = Effect.fnUntraced(function* (refresh: boolean) {
          const session = yield* sessionFor(client, url, environment, refresh);
          const sealed = yield* session
            .seal(inner)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SecureHttpFailure({ description: "Could not seal the request.", cause }),
              ),
            );
          const response = yield* client.execute(
            HttpClientRequest.post(sealedUrl).pipe(
              HttpClientRequest.bodyUint8Array(sealed.envelope, "application/octet-stream"),
            ),
          );
          if (response.status === SECURE_HTTP_STALE_KEY_STATUS) return Option.none();
          if (response.status !== 200) {
            return yield* new SecureHttpFailure({
              description: `The environment refused the sealed request (${response.status}).`,
            });
          }
          const opened: SecureHttpInnerResponse = yield* response.arrayBuffer.pipe(
            Effect.flatMap((bytes) => sealed.open(new Uint8Array(bytes))),
            Effect.mapError(
              (cause) =>
                new SecureHttpFailure({
                  description: "Could not open the sealed response.",
                  cause,
                }),
            ),
          );
          return Option.some(opened);
        });
        const first = yield* attempt(false);
        const opened = Option.isSome(first)
          ? first.value
          : Option.getOrUndefined(yield* attempt(true));
        if (opened === undefined) {
          return yield* new SecureHttpFailure({
            description: "The environment refused its own exchange key.",
          });
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(NULL_BODY_STATUSES.has(opened.status) ? null : (opened.body as BodyInit), {
            status: opened.status,
            headers: opened.headers,
          }),
        );
      }).pipe(
        Effect.catchTags({
          SecureHttpFailure: (failure) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: failure.description,
                  cause: failure,
                }),
              }),
            ),
        }),
        Effect.provideContext(crypto),
      ),
    );
};

/**
 * The client for HTTP requests to one environment: sealed when this platform can seal and the
 * environment's identity key is pinned, otherwise none. A pin that cannot be read fails rather than
 * looking like no pin, so a request to a pinned environment never goes out in plaintext.
 */
export const sealedEnvironmentHttpClient = Effect.fn(
  "clientRuntime.rpc.sealedEnvironmentHttpClient",
)(function* (
  environmentId: EnvironmentId,
  services: {
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly registrations: Option.Option<Persistence.ConnectionRegistrationStore["Service"]>;
  },
) {
  const seal = Option.getOrUndefined(services.signer)?.sealHttpClient;
  if (seal === undefined || Option.isNone(services.registrations)) {
    return Option.none<HttpClient.HttpClient>();
  }
  const pinned = yield* services.registrations.value.environmentKey(environmentId);
  if (Option.isNone(pinned)) return Option.none<HttpClient.HttpClient>();
  return Option.some(
    seal(yield* HttpClient.HttpClient, { environmentId, pinnedKey: pinned.value }),
  );
});

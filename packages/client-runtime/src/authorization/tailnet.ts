import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";

import { TailnetConnectionCredential } from "../connection/catalog.ts";
import type * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { credentialMissingError, mapRemoteEnvironmentError } from "../connection/errors.ts";
import {
  ConnectionBlockedError,
  DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS,
  type ConnectionAttemptError,
} from "../connection/model.ts";
import { tailnetRefusalError } from "../connection/tailnet.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import { exchangeRemoteDpopAccessToken } from "./remote.ts";

const TAILNET_SIGN_IN_TIMEOUT_MS = 10_000;

const isTailnetCredential = Schema.is(TailnetConnectionCredential);

const proofError = () =>
  new ConnectionBlockedError({
    reason: "configuration",
    detail: "Could not create the Tailscale sign-in proof.",
    hop: "device",
  });

/**
 * Signs in at a direct tailnet address with this device's DPoP key, then
 * exchanges the two-minute grant for a session, like after a T3 Connect mint.
 */
export const signInOverTailnet = Effect.fn("clientRuntime.authorization.signInOverTailnet")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly signer: ManagedRelayDpopSigner["Service"];
    readonly clientMetadata?: AuthClientPresentationMetadata;
  }) {
    const thumbprint = yield* input.signer.thumbprint.pipe(Effect.mapError(proofError));
    const signInUrl = environmentEndpointUrl(input.httpBaseUrl, "/api/auth/tailnet");
    const signInProof = yield* input.signer
      .createProof({ method: "POST", url: signInUrl })
      .pipe(Effect.mapError(proofError));
    const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "tailnet");
    const answer = yield* executeEnvironmentHttpRequest(
      signInUrl,
      TAILNET_SIGN_IN_TIMEOUT_MS,
      client.signIn({ headers: { dpop: signInProof } }).pipe(
        Effect.map((grant) => ({ _tag: "Granted" as const, grant })),
        // A refusal is a declared answer, not a transport failure.
        Effect.catchTags({
          EnvironmentTailnetSignInRefusedError: (refused) =>
            Effect.succeed({ _tag: "Refused" as const, refused }),
        }),
      ),
    ).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
    if (answer._tag === "Refused") {
      return yield* tailnetRefusalError(
        answer.refused.reason,
        answer.refused.traceId,
        answer.refused.suggestedGrant,
      );
    }
    const tokenProof = yield* input.signer
      .createProof({
        method: "POST",
        url: environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
      })
      .pipe(Effect.mapError(proofError));
    const access = yield* exchangeRemoteDpopAccessToken({
      httpBaseUrl: input.httpBaseUrl,
      credential: answer.grant.credential,
      dpopProof: tokenProof,
      ...(input.clientMetadata === undefined ? {} : { clientMetadata: input.clientMetadata }),
    }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
    const issuedAt = yield* Clock.currentTimeMillis;
    return new TailnetConnectionCredential({
      signInBaseUrl: input.httpBaseUrl,
      accessToken: access.access_token,
      expiresAtEpochMs: issuedAt + access.expires_in * 1_000,
      dpopThumbprint: thumbprint,
    });
  },
);

/**
 * Tailscale sessions keyed by credential id. A session renews by signing in
 * again at its pinned address, before expiry or after a rejection, so every
 * host check runs again. Concurrent callers share one sign-in.
 */
export const makeTailnetSessions = (input: {
  readonly credentials: ConnectionCredentialStore.ConnectionCredentialStore["Service"];
  readonly signer: ManagedRelayDpopSigner["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly clientMetadata: AuthClientPresentationMetadata;
  readonly scope: Scope.Scope;
}) => {
  const renewals = new Map<
    string,
    {
      readonly id: object;
      readonly fiber: Fiber.Fiber<TailnetConnectionCredential, ConnectionAttemptError>;
    }
  >();

  const renew = Effect.fn("clientRuntime.authorization.tailnet.renew")(function* (
    credentialId: string,
    current: TailnetConnectionCredential,
  ) {
    const pending = renewals.get(credentialId);
    if (pending !== undefined) return yield* Fiber.join(pending.fiber);
    const id = {};
    const fiber = yield* signInOverTailnet({
      httpBaseUrl: current.signInBaseUrl,
      signer: input.signer,
      clientMetadata: input.clientMetadata,
    }).pipe(
      Effect.tap((fresh) => input.credentials.put(credentialId, fresh)),
      Effect.provideService(HttpClient.HttpClient, input.httpClient),
      Effect.ensuring(
        Effect.sync(() => {
          if (renewals.get(credentialId)?.id === id) renewals.delete(credentialId);
        }),
      ),
      // One caller's interruption must not cancel the renewal others wait on.
      Effect.forkIn(input.scope),
    );
    renewals.set(credentialId, { id, fiber });
    return yield* Fiber.join(fiber);
  });

  /** The stored session, or a fresh one when it is missing a key match, near expiry, or rejected. */
  const session = Effect.fn("clientRuntime.authorization.tailnet.session")(function* (
    credentialId: string,
    rejectedAccessToken?: string,
  ) {
    const stored = Option.getOrUndefined(yield* input.credentials.get(credentialId));
    if (stored === undefined || !isTailnetCredential(stored)) {
      return yield* credentialMissingError(credentialId);
    }
    const thumbprint = yield* input.signer.thumbprint.pipe(Effect.mapError(proofError));
    const now = yield* Clock.currentTimeMillis;
    if (
      stored.dpopThumbprint === thumbprint &&
      stored.expiresAtEpochMs > now + DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS &&
      stored.accessToken !== rejectedAccessToken
    ) {
      return stored;
    }
    return yield* renew(credentialId, stored);
  });

  return { session };
};

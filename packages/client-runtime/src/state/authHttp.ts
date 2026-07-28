import type { AuthEnvironmentScope, AuthSessionId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpMethod } from "effect/unstable/http";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Access management is interactive: the user is waiting on a dialog, so fail
// fast rather than leaving a spinner up while a wedged endpoint stalls.
const AUTH_MUTATION_TIMEOUT_MS = 10_000;

/**
 * Raised when an access-management call is attempted against an environment
 * that has no live prepared connection. The catalog can hold an environment
 * that is reconnecting or unreachable, and those have no endpoint or credential
 * to address, so the mutation cannot be attempted at all.
 */
export class EnvironmentNotConnectedError extends Data.TaggedError(
  "@t3tools/client-runtime/state/authHttp/EnvironmentNotConnectedError",
)<{ readonly message: string }> {}

/**
 * Resolve the endpoint, credential and authorization headers for an
 * authenticated request against the environment this effect is running in.
 *
 * The access-management endpoints have always existed per-environment; only the
 * client bound them to the primary. Routing them through the supervisor's
 * prepared connection lets a client with no managed backend of its own manage a
 * saved server's pairing links and sessions, using whichever credential that
 * connection was established with.
 */
const prepareAuthRequest = Effect.fn("clientRuntime.state.authHttp.prepareAuthRequest")(function* (
  method: HttpMethod.HttpMethod,
  pathname: string,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new EnvironmentNotConnectedError({
      message: "This environment is not connected, so its access settings cannot be changed.",
    });
  }
  const { httpAuthorization, httpBaseUrl } = prepared.value;
  const requestUrl = environmentEndpointUrl(httpBaseUrl, pathname);
  const client = yield* makeEnvironmentHttpApiClient(httpBaseUrl);
  // Optional: only relay/DPoP connections need a signer, so bearer and
  // same-origin session connections must still work without one.
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(httpAuthorization, method, requestUrl, signer);
  return { client, headers, httpAuthorization, requestUrl };
});

/**
 * Read the calling client's own session state for this environment, including
 * the scopes it was granted. Access-management UI keys off this rather than the
 * primary environment's session, so it reflects what this client may actually do
 * on the server it is looking at.
 */
export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.authHttp.fetchEnvironmentSessionState",
)(function* () {
  const { client, headers, httpAuthorization, requestUrl } = yield* prepareAuthRequest(
    "GET",
    "/api/auth/session",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    AUTH_MUTATION_TIMEOUT_MS,
    withEnvironmentCredentials(httpAuthorization, client.auth.session({ headers })),
  );
});

export const createEnvironmentPairingCredential = Effect.fn(
  "clientRuntime.state.authHttp.createEnvironmentPairingCredential",
)(function* (input: {
  readonly label?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const { client, headers, httpAuthorization, requestUrl } = yield* prepareAuthRequest(
    "POST",
    "/api/auth/pairing-token",
  );
  const trimmedLabel = input.label?.trim();
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    AUTH_MUTATION_TIMEOUT_MS,
    withEnvironmentCredentials(
      httpAuthorization,
      client.auth.pairingCredential({
        headers,
        payload: {
          ...(trimmedLabel ? { label: trimmedLabel } : {}),
          ...(input.scopes ? { scopes: input.scopes } : {}),
        },
      }),
    ),
  );
});

export const revokeEnvironmentPairingLink = Effect.fn(
  "clientRuntime.state.authHttp.revokeEnvironmentPairingLink",
)(function* (input: { readonly id: string }) {
  const { client, headers, httpAuthorization, requestUrl } = yield* prepareAuthRequest(
    "POST",
    "/api/auth/pairing-links/revoke",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    AUTH_MUTATION_TIMEOUT_MS,
    withEnvironmentCredentials(
      httpAuthorization,
      client.auth.revokePairingLink({ headers, payload: { id: input.id } }),
    ),
  );
});

export const revokeEnvironmentClientSession = Effect.fn(
  "clientRuntime.state.authHttp.revokeEnvironmentClientSession",
)(function* (input: { readonly sessionId: AuthSessionId }) {
  const { client, headers, httpAuthorization, requestUrl } = yield* prepareAuthRequest(
    "POST",
    "/api/auth/clients/revoke",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    AUTH_MUTATION_TIMEOUT_MS,
    withEnvironmentCredentials(
      httpAuthorization,
      client.auth.revokeClient({ headers, payload: { sessionId: input.sessionId } }),
    ),
  );
});

export const revokeOtherEnvironmentClientSessions = Effect.fn(
  "clientRuntime.state.authHttp.revokeOtherEnvironmentClientSessions",
)(function* () {
  const { client, headers, httpAuthorization, requestUrl } = yield* prepareAuthRequest(
    "POST",
    "/api/auth/clients/revoke-others",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    AUTH_MUTATION_TIMEOUT_MS,
    withEnvironmentCredentials(httpAuthorization, client.auth.revokeOtherClients({ headers })),
  );
});

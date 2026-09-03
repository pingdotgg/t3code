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

const AUTH_MUTATION_TIMEOUT_MS = 10_000;

export class EnvironmentNotConnectedError extends Data.TaggedError(
  "@t3tools/client-runtime/state/authHttp/EnvironmentNotConnectedError",
)<{ readonly message: string }> {}

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
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(httpAuthorization, method, requestUrl, signer);
  return { client, headers, httpAuthorization, requestUrl };
});

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

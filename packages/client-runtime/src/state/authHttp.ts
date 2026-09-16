import type { AuthEnvironmentScope, AuthSessionId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpMethod } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
} from "./environmentHttpAuth.ts";

const AUTH_MUTATION_TIMEOUT_MS = 10_000;

export class EnvironmentNotConnectedError extends Data.TaggedError(
  "@t3tools/client-runtime/state/authHttp/EnvironmentNotConnectedError",
)<{ readonly message: string }> {}

const executeAuthRequest = <A, E, R>(input: {
  readonly method: HttpMethod.HttpMethod;
  readonly pathname: string;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}) =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new EnvironmentNotConnectedError({
        message: "This environment is not connected, so its access settings cannot be changed.",
      });
    }
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: prepared.value,
      signer,
      remoteAuthorization,
      method: input.method,
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, input.pathname),
      timeoutMs: AUTH_MUTATION_TIMEOUT_MS,
      request: input.request,
      ...(input.isUnauthorizedResponse === undefined
        ? {}
        : { isUnauthorizedResponse: input.isUnauthorizedResponse }),
    });
  });

export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.authHttp.fetchEnvironmentSessionState",
)(function* () {
  return yield* executeAuthRequest({
    method: "GET",
    pathname: "/api/auth/session",
    request: ({ client, headers }) => client.auth.session({ headers }),
    isUnauthorizedResponse: (response) => !response.authenticated,
  });
});

export const createEnvironmentPairingCredential = Effect.fn(
  "clientRuntime.state.authHttp.createEnvironmentPairingCredential",
)(function* (input: {
  readonly label?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const trimmedLabel = input.label?.trim();
  return yield* executeAuthRequest({
    method: "POST",
    pathname: "/api/auth/pairing-token",
    request: ({ client, headers }) =>
      client.auth.pairingCredential({
        headers,
        payload: {
          ...(trimmedLabel ? { label: trimmedLabel } : {}),
          ...(input.scopes ? { scopes: input.scopes } : {}),
        },
      }),
  });
});

export const revokeEnvironmentPairingLink = Effect.fn(
  "clientRuntime.state.authHttp.revokeEnvironmentPairingLink",
)(function* (input: { readonly id: string }) {
  return yield* executeAuthRequest({
    method: "POST",
    pathname: "/api/auth/pairing-links/revoke",
    request: ({ client, headers }) =>
      client.auth.revokePairingLink({ headers, payload: { id: input.id } }),
  });
});

export const revokeEnvironmentClientSession = Effect.fn(
  "clientRuntime.state.authHttp.revokeEnvironmentClientSession",
)(function* (input: { readonly sessionId: AuthSessionId }) {
  return yield* executeAuthRequest({
    method: "POST",
    pathname: "/api/auth/clients/revoke",
    request: ({ client, headers }) =>
      client.auth.revokeClient({ headers, payload: { sessionId: input.sessionId } }),
  });
});

export const revokeOtherEnvironmentClientSessions = Effect.fn(
  "clientRuntime.state.authHttp.revokeOtherEnvironmentClientSessions",
)(function* () {
  return yield* executeAuthRequest({
    method: "POST",
    pathname: "/api/auth/clients/revoke-others",
    request: ({ client, headers }) => client.auth.revokeOtherClients({ headers }),
  });
});

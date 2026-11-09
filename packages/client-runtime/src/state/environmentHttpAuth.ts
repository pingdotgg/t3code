import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiGroupClient, RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpRequest.ts";

export * from "./environmentHttpRequest.ts";

/** Sends the request with this client's own credentials on the supervised environment. */
export const executeConnectedEnvironmentHttpRequest = Effect.fn(
  "clientRuntime.state.executeConnectedEnvironmentHttpRequest",
)(function* <Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1], A, E, R>(
  input: Omit<
    Parameters<typeof executeAuthenticatedEnvironmentHttpRequest<Group, A, E, R>>[0],
    "prepared" | "signer" | "remoteAuthorization"
  >,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new RemoteEnvironmentAuthFetchError({
      message: "The environment is not connected.",
      cause: supervisor.target._tag,
    });
  }
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
  });
});

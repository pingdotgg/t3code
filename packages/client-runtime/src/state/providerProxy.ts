import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const LOGIN_REFRESH_MS = 2_000;
// The supervisor can recover, crash, or restart after a settings change at any time, so the
// managed view keeps reading its state while it is mounted.
const STATE_REFRESH_MS = 3_000;

export function createProviderProxyEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:provider-proxy:state",
    tag: WS_METHODS.providerProxyGetState,
    staleTimeMs: 0,
    refreshIntervalMs: STATE_REFRESH_MS,
  });
  // A sign-in finishes in the browser, so its status is read until it settles.
  const loginStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:provider-proxy:login-status",
    tag: WS_METHODS.providerProxyGetLoginStatus,
    staleTimeMs: 0,
    refreshIntervalMs: LOGIN_REFRESH_MS,
    isFinal: (status) => status.status !== "wait",
    onAnswer: ({ environmentId }, status, registry) =>
      status.status === "ok"
        ? Effect.sync(() => registry.refresh(state({ environmentId, input: {} })))
        : Effect.void,
  });
  return {
    state,
    loginStatus,
    startLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:start-login",
      tag: WS_METHODS.providerProxyStartLogin,
    }),
    completeLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:complete-login",
      tag: WS_METHODS.providerProxyCompleteLogin,
    }),
    setAccountDisabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:set-account-disabled",
      tag: WS_METHODS.providerProxySetAccountDisabled,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(state({ environmentId, input: {} }))),
    }),
    removeAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider-proxy:remove-account",
      tag: WS_METHODS.providerProxyRemoveAccount,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(state({ environmentId, input: {} }))),
    }),
  };
}

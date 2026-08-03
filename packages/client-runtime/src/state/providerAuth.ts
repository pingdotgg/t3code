/**
 * Provider account sign-in atoms (fork f1).
 *
 * The login rides one streaming RPC whose scope is the login's lifetime, so
 * the atom's *mount* starts the handshake and its *unmount* cancels it — no
 * cancel command, no `loginId` bookkeeping on the client.
 *
 * That is also why `provider.startSignIn` is an `EnvironmentStreamCommandRpcTag`
 * rather than a subscription tag: subscriptions auto-resubscribe on reconnect,
 * which would silently restart a login the user had already abandoned.
 *
 * @module client-runtime/state/providerAuth
 */
import {
  WS_METHODS,
  type ProviderInstanceId,
  type ProviderSignInEvent,
  type ProviderSignInMode,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStream } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export interface ProviderSignInRequest {
  readonly instanceId: ProviderInstanceId;
  readonly mode: ProviderSignInMode;
  /**
   * Bumped by the UI to restart a login after a failure, or when the user
   * switches modes. It is part of the atom family key but is deliberately
   * stripped before the RPC call — the wire payload stays exactly
   * `ProviderStartSignInInput`.
   */
  readonly attempt: number;
}

/**
 * Latest event of the running handshake, or `undefined` before the first one
 * lands. Callers render straight off this.
 */
export type ProviderSignInStatus = ProviderSignInEvent | undefined;

export function createProviderAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /**
     * Mount to start a sign-in; unmount to cancel it. The idle TTL is zero so
     * closing the dialog tears the login down immediately instead of leaving
     * an app-server child alive for the default five minutes.
     *
     * NOTE the mismatch between the family's name and the tag: this is built
     * with `createEnvironmentSubscriptionAtomFamily` but `runStream` binds ONE
     * `EnvironmentStreamCommandRpcTag` session — the family contributes only
     * keying and the idle TTL, and nothing auto-resubscribes. Do not "fix" it
     * onto `subscribe()`: that would re-run an abandoned login on every
     * reconnect, which is the failure the module docstring above describes.
     */
    signInEvents: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:provider:sign-in",
      idleTtlMs: 0,
      subscribe: (input: ProviderSignInRequest) =>
        runStream(WS_METHODS.providerStartSignIn, {
          instanceId: input.instanceId,
          mode: input.mode,
        }),
    }),
    signOut: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:sign-out",
      tag: WS_METHODS.providerSignOut,
    }),
  };
}

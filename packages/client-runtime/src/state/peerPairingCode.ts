/**
 * A one-use pairing code for linking, minted on the environment being linked to with the
 * user's own session there, so a link card can be answered without fetching a code by hand.
 * It carries exactly what an agent sign-in with the chosen access needs.
 */
import { type AuthMcpClientAccess, mcpClientScopes } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

const MINT_TIMEOUT_MS = 8_000;
const PEER_PAIRING_CODE_LABEL = "T3 Code link";

/** Minting failed; the user can still paste a code from the other environment. */
export class PeerPairingCodeError extends Data.TaggedError("PeerPairingCodeError")<{
  readonly reason: "not_allowed" | "unavailable";
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.reason === "not_allowed"
      ? "Your session there cannot create pairing codes. Paste a code from there instead."
      : "Could not get a pairing code from there. Paste a code from there instead.";
  }
}

const mintPeerPairingCode = Effect.fn("clientRuntime.state.mintPeerPairingCode")(function* (
  prepared: PreparedConnection,
  access: AuthMcpClientAccess,
): Effect.fn.Return<string, PeerPairingCodeError, HttpClient.HttpClient> {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const minted = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    group: "auth",
    method: "POST",
    url: (urls) => urls.pairingCredential(),
    timeoutMs: MINT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.pairingCredential({
        headers,
        payload: { label: PEER_PAIRING_CODE_LABEL, scopes: mcpClientScopes(access) },
      }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PeerPairingCodeError({
          reason:
            cause._tag === "EnvironmentScopeRequiredError" ||
            cause._tag === "EnvironmentOperationForbiddenError"
              ? "not_allowed"
              : "unavailable",
          cause,
        }),
    ),
  );
  return minted.credential;
});

/**
 * Mints a code on the environment it runs in. Each run mints its own: a code
 * is one-use, so two overlapping answers must never share one.
 */
export function createPeerPairingCodeCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:peer-pairing-code:mint",
    execute: Effect.fn(function* (access: AuthMcpClientAccess) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) {
        return yield* new PeerPairingCodeError({
          reason: "unavailable",
          cause: "The environment is not connected.",
        });
      }
      return yield* mintPeerPairingCode(prepared.value, access);
    }),
  });
}

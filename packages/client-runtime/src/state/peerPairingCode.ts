/**
 * A pairing code for linking, minted on the environment being linked to with
 * the user's own session there, so a link card can be answered without the
 * user fetching a code by hand. The code is one-use, carries only what an
 * agent sign-in needs, and goes straight into the link answer.
 */
import {
  type AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const MINT_TIMEOUT_MS = 8_000;
const PEER_PAIRING_CODE_LABEL = "T3 Code link";
/** An agent signing in there needs these, whatever access the user picks. */
const LINK_SCOPES: ReadonlyArray<AuthGrantScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
];

/** Minting failed; the user can still paste a code from the other environment. */
export class PeerPairingCodeError extends Data.TaggedError("PeerPairingCodeError")<{
  readonly reason: "not_allowed" | "unavailable";
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason === "not_allowed"
      ? "Your session there cannot create pairing codes. Paste a code from there instead."
      : "Could not get a pairing code from there. Paste a code from there instead.";
  }
}

export const mintPeerPairingCode = Effect.fn("clientRuntime.state.mintPeerPairingCode")(function* (
  prepared: PreparedConnection,
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/auth/pairing-token"),
    timeoutMs: MINT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.pairingCredential({
        headers,
        payload: { label: PEER_PAIRING_CODE_LABEL, scopes: LINK_SCOPES },
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

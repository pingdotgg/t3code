/**
 * One-use pairing codes minted on an environment with the user's own session there: a code
 * for linking, so a link card can be answered without fetching a code by hand, and a code
 * that approves one app's sign-in at a set level. Each carries exactly what an agent
 * sign-in with the chosen access needs.
 */
import {
  type AuthCreatePairingCredentialInput,
  type AuthMcpClientAccess,
  type AuthPairingCredentialResult,
  type EnvironmentId,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/reactivity";
import * as Result from "effect/Result";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, squashAtomCommandFailure } from "./runtime.ts";

const MINT_TIMEOUT_MS = 8_000;
const PEER_PAIRING_CODE_LABEL = "T3 Code link";
const MCP_APPROVAL_CODE_LABEL = "App sign-in";

/** Minting failed; the user can still paste a code from the other environment. */
export class PeerPairingCodeError extends Schema.TaggedError<PeerPairingCodeError>()(
  "PeerPairingCodeError",
  {
    reason: Schema.Literals(["not_allowed", "unavailable"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.reason === "not_allowed"
      ? "Your session there cannot create pairing codes. Paste a code from there instead."
      : "Could not get a pairing code from there. Paste a code from there instead.";
  }
}

const mintPairingCredential = Effect.fn("clientRuntime.state.mintPairingCredential")(function* (
  prepared: PreparedConnection,
  payload: AuthCreatePairingCredentialInput,
): Effect.fn.Return<AuthPairingCredentialResult, PeerPairingCodeError, HttpClient.HttpClient> {
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
    request: ({ client, headers }) => client.pairingCredential({ headers, payload }),
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
  return minted;
});

// Untraced: mintPairingCredential owns the span.
const mintOnEnvironment = Effect.fnUntraced(function* (payload: AuthCreatePairingCredentialInput) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new PeerPairingCodeError({
      reason: "unavailable",
      cause: "The environment is not connected.",
    });
  }
  return yield* mintPairingCredential(prepared.value, payload);
});

/**
 * Mints a fresh code on `environmentId` with this client's session there, for linking with
 * `access`. Each call mints its own: a code is one-use, so two overlapping answers must never
 * share one. Fails with `PeerPairingCodeError` when the session may not create one.
 */
export function createPeerPairingCodeMinter<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
  registry: AtomRegistry.AtomRegistry,
) {
  const mint = createEnvironmentCommand(runtime, {
    label: "environment-data:peer-pairing-code:mint",
    execute: (access: AuthMcpClientAccess) =>
      mintOnEnvironment({ label: PEER_PAIRING_CODE_LABEL, scopes: mcpClientScopes(access) }).pipe(
        Effect.map((minted) => minted.credential),
      ),
  });
  return async (
    environmentId: EnvironmentId,
    access: AuthMcpClientAccess,
  ): Promise<Result.Result<string, unknown>> => {
    const result = await mint.run(registry, { environmentId, input: access });
    return result._tag === "Success"
      ? Result.succeed(result.value)
      : Result.fail(squashAtomCommandFailure(result));
  };
}

/**
 * Mints a hidden code that approves one app's sign-in at `access`, and only that. Servers
 * without `mcpApprovalCodes` ignore the level, so check the capability first.
 */
export function createMcpApprovalCodeCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:mcp-approval-code:mint",
    execute: (access: AuthMcpClientAccess) =>
      mintOnEnvironment({ label: MCP_APPROVAL_CODE_LABEL, access }),
  });
}

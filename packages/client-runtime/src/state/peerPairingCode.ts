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
import type { Atom } from "effect/reactivity";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { type PreparedConnection, RelayConnectionTarget } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createRuntimeCommand } from "./runtime.ts";

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

export class ConnectApprovalCodeError extends Schema.TaggedError<ConnectApprovalCodeError>()(
  "ConnectApprovalCodeError",
  {
    reason: Schema.Literals(["other_address", "not_allowed", "unavailable"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "other_address":
        return "This sign-in did not start on that environment's T3 Connect address.";
      case "not_allowed":
        return "This account cannot approve app sign-ins on that environment.";
      case "unavailable":
        return "Could not reach that environment through T3 Connect with this account.";
    }
  }
}

const mintPairingCredential = Effect.fn("clientRuntime.state.mintPairingCredential")(function* (
  prepared: Pick<
    PreparedConnection,
    "environmentId" | "httpBaseUrl" | "httpAuthorization" | "target"
  >,
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
 * Mints a code on the environment it runs in. Each run mints its own: a code
 * is one-use, so two overlapping answers must never share one.
 */
export function createPeerPairingCodeCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "environment-data:peer-pairing-code:mint",
    execute: (access: AuthMcpClientAccess) =>
      mintOnEnvironment({ label: PEER_PAIRING_CODE_LABEL, scopes: mcpClientScopes(access) }).pipe(
        Effect.map((minted) => minted.credential),
      ),
  });
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

/**
 * Mints an app approval code on an environment the T3 Connect account owns, for the sign-in
 * page at `pageOrigin`. It refuses before minting unless that page is the environment's own
 * relay address, so a crafted link cannot send the code anywhere else.
 */
export const mintConnectMcpApprovalCode = Effect.fn(
  "clientRuntime.state.mintConnectMcpApprovalCode",
)(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly pageOrigin: string;
  readonly access: AuthMcpClientAccess;
}) {
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  // The relay grants this only for an environment linked to the signed-in account.
  const authorized = yield* remote
    .authorizeDpopHttp({ expectedEnvironmentId: input.environmentId })
    .pipe(
      Effect.mapError((cause) => new ConnectApprovalCodeError({ reason: "unavailable", cause })),
    );
  if (new URL(authorized.httpBaseUrl).origin !== input.pageOrigin) {
    return yield* new ConnectApprovalCodeError({
      reason: "other_address",
      cause: input.pageOrigin,
    });
  }
  const minted = yield* mintPairingCredential(
    {
      environmentId: input.environmentId,
      httpBaseUrl: authorized.httpBaseUrl,
      httpAuthorization: authorized.httpAuthorization,
      target: new RelayConnectionTarget({
        environmentId: input.environmentId,
        label: authorized.label,
      }),
    },
    { label: MCP_APPROVAL_CODE_LABEL, access: input.access },
  ).pipe(Effect.mapError((cause) => new ConnectApprovalCodeError({ reason: cause.reason, cause })));
  return minted.credential;
});

export function createConnectMcpApprovalCodeCommand<R, E>(
  runtime: Atom.AtomRuntime<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization | HttpClient.HttpClient | R,
    E
  >,
) {
  return createRuntimeCommand(runtime, {
    label: "environment-data:connect-mcp-approval-code:mint",
    execute: mintConnectMcpApprovalCode,
  });
}

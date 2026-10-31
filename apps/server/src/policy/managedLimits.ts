/**
 * managedLimits - what `limits.clients` and `limits.connect` in the managed policy allow, and the
 * one error every refusal uses so each transport can show the administrator's organization.
 *
 * @module managedLimits
 */
import type {
  ManagedPolicyClient,
  ManagedPolicyDocument,
  ServerAuthPolicy,
} from "@t3tools/contracts";
import {
  disableTailscaleServe,
  readTailscaleServeMountsProxyingTo,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { loopbackBindAddress } from "../auth/utils.ts";

type PolicyDocument = { readonly document: ManagedPolicyDocument | undefined };

export class ManagedPolicyRefusedError extends Schema.TaggedError<ManagedPolicyRefusedError>()(
  "ManagedPolicyRefusedError",
  {
    organization: Schema.String,
    /** What the policy does not allow, for example "T3 Connect". */
    action: Schema.String,
    /** What that means for this request, for example "so the server cannot listen on 0.0.0.0". */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return `${this.organization}'s policy does not allow ${this.action}${
      this.detail === undefined ? "" : `, ${this.detail}`
    }.`;
  }
}

const CLIENT_AUTH_POLICY: Record<ManagedPolicyClient, ServerAuthPolicy> = {
  desktop: "desktop-managed-local",
  "local-browser": "loopback-browser",
  remote: "remote-reachable",
};

const AUTH_POLICY_ACTION: Record<ServerAuthPolicy, string> = {
  "desktop-managed-local": "the desktop app",
  "loopback-browser": "browsers on this machine",
  "remote-reachable": "remote clients",
  "unsafe-no-auth": "running without authentication",
};

/** Whether the server may run with `authPolicy`. Any policy file rules out `unsafe-no-auth`. */
export function allowsAuthPolicy(policy: PolicyDocument, authPolicy: ServerAuthPolicy): boolean {
  if (policy.document === undefined) return true;
  if (authPolicy === "unsafe-no-auth") return false;
  const clients = policy.document.limits?.clients;
  return (
    clients === undefined || clients.some((client) => CLIENT_AUTH_POLICY[client] === authPolicy)
  );
}

/** Whether anything off this machine may pair, by LAN, Tailscale, or a minted link. */
export const allowsRemoteClients = (policy: PolicyDocument) =>
  allowsAuthPolicy(policy, "remote-reachable");

/** T3 Connect is a way for remote clients in, so a policy without `remote` turns it off too. */
export const allowsConnect = (policy: PolicyDocument) =>
  policy.document?.limits?.connect !== false && allowsRemoteClients(policy);

const refuse = (policy: PolicyDocument, action: string, detail?: string) =>
  new ManagedPolicyRefusedError({
    organization: policy.document?.organization ?? "Your organization",
    action,
    ...(detail === undefined ? {} : { detail }),
  });

export const refuseConnect = (policy: PolicyDocument) => refuse(policy, "T3 Connect");

// Node throws ENOTDIR, outside the spawner's error mapping, when PATH ends in a file.
const isMissingCli = (cause: unknown) =>
  (PlatformError.isPlatformError(cause) && cause.reason._tag === "NotFound") ||
  (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR");

/** Tailscale answers that leave nothing forwarding here right now. */
const NOTHING_TO_CLOSE: ReadonlySet<TailscaleStderrDiagnostic | undefined> = new Set([
  "not-running",
  "not-logged-in",
]);

/**
 * Turns off the Tailscale Serve routes that forward to `port`, such as one `t3 pair --tailscale`
 * left from before the policy, and keeps any other route on the same port. Runs before the server
 * binds, and fails unless a fresh read shows no route here, since `off` can exit 0 and leave it.
 * Without the CLI, or with Tailscale down or logged out, nothing forwards, so nothing is closed.
 */
export const closeTailscaleServeTo = Effect.fn("managedLimits.closeTailscaleServeTo")(function* (
  policy: PolicyDocument,
  port: number,
) {
  if (allowsRemoteClients(policy)) return;
  const readMounts = readTailscaleServeMountsProxyingTo(port).pipe(
    Effect.catchTags({
      // Only a CLI that is not there; one that will not run might still front a daemon.
      TailscaleCommandSpawnError: (error) =>
        isMissingCli(error.cause) ? Effect.succeed([]) : Effect.fail(error),
      TailscaleCommandExitError: (error) =>
        NOTHING_TO_CLOSE.has(error.stderrDiagnostic) ? Effect.succeed([]) : Effect.fail(error),
    }),
    // Tailscale errors carry only labelled diagnostics, never raw stderr, so they are safe to log.
    Effect.tapError((cause) =>
      Effect.logWarning("Tailscale Serve could not be checked", { cause }),
    ),
    Effect.mapError(() =>
      refuseRemoteClients(
        policy,
        "so the server does not start until Tailscale Serve can be checked",
      ),
    ),
  );
  const mounts = yield* readMounts;
  if (mounts.length === 0) return;
  for (const mount of mounts) {
    yield* disableTailscaleServe(mount).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Tailscale Serve route could not be turned off", { ...mount, cause }),
      ),
    );
  }
  const left = yield* readMounts;
  if (left.length > 0) {
    return yield* refuseRemoteClients(
      policy,
      `so the server does not start while Tailscale Serve forwards ${left
        .map(
          ({ servePort, mount }) =>
            `port ${servePort} at ${mount} here; turn it off with "tailscale serve --https=${servePort} --set-path=${mount} off"`,
        )
        .join(", and ")}`,
    );
  }
  yield* Effect.logInfo("Turned off Tailscale Serve the managed policy does not allow", {
    mounts,
  });
});

export const refuseRemoteClients = (policy: PolicyDocument, detail?: string) =>
  refuse(policy, AUTH_POLICY_ACTION["remote-reachable"], detail);

/**
 * Fails when the server would accept clients the policy leaves out; otherwise returns the address
 * to bind. Runs before the server binds, so a refused configuration never listens, not even
 * briefly. Without `remote` that address is the loopback literal the check approved, never a name.
 */
export const checkServerReachability = Effect.fn("managedLimits.checkServerReachability")(
  function* (
    policy: PolicyDocument,
    input: {
      readonly authPolicy: ServerAuthPolicy;
      readonly host: string | undefined;
      readonly tailscaleServeEnabled: boolean;
    },
  ) {
    const cannotListen = () =>
      refuseRemoteClients(
        policy,
        `so the server cannot listen on ${input.host === "" ? "every interface" : (input.host ?? "this host")}`,
      );
    if (!allowsAuthPolicy(policy, input.authPolicy)) {
      return yield* input.authPolicy === "remote-reachable"
        ? cannotListen()
        : refuse(policy, AUTH_POLICY_ACTION[input.authPolicy]);
    }
    if (allowsRemoteClients(policy)) return input.host ?? "127.0.0.1";
    if (input.tailscaleServeEnabled) {
      return yield* refuseRemoteClients(policy, "so Tailscale Serve cannot be turned on");
    }
    return loopbackBindAddress(input.host) ?? (yield* cannotListen());
  },
);

import type {
  EnvironmentCloudLinkStateResult,
  EnvironmentConnectReachability,
} from "@t3tools/contracts";
import type { Discovery } from "@t3tools/client-runtime/relay";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";

import { isManagedTunnelActive, t3ConnectMcpUrl } from "~/cloud/t3ConnectState";

type Unreachable = Extract<EnvironmentConnectReachability, { readonly status: "unreachable" }>;

/**
 * What stands between the user and the wizard's steps. Only `open` lets them go on: cloud apps
 * need a public address, so the environment must answer on its T3 Connect tunnel.
 */
export type McpGate =
  | { readonly kind: "checking" }
  | { readonly kind: "sign-in" }
  /**
   * `relay`: T3 Connect reports the saved machine offline, or its list could not be read; both
   * keep a retry. Null when that list shows nothing wrong, so the user should reconnect.
   */
  | { readonly kind: "disconnected"; readonly relay: "offline" | "failed" | null }
  | { readonly kind: "update" }
  | { readonly kind: "no-relay-read" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "turn-on" }
  | { readonly kind: "offline"; readonly reachability: Unreachable | null }
  | { readonly kind: "open"; readonly mcpUrl: string };

export function resolveMcpGate(input: {
  /** Undefined until T3 Connect sign-in has loaded. */
  readonly signedIn: boolean | undefined;
  readonly connected: boolean;
  /** The environment's `mcpApprovalCodes` capability; undefined until its config loads. */
  readonly approvalCodes: boolean | undefined;
  readonly canReadRelay: boolean;
  readonly linkState: EnvironmentCloudLinkStateResult | null;
  readonly linkStateError: string | null;
  /** A backend this device runs; its link state names its own tunnel. */
  readonly thisMachine: boolean;
  /** The account's machines on T3 Connect, where a saved machine's address and health come from. */
  readonly relay:
    | { readonly status: "loading" | "failed" }
    | {
        readonly status: "listed";
        readonly endpoint: RelayManagedEndpoint | undefined;
        readonly availability?: Discovery.RelayEnvironmentAvailability | undefined;
      };
  /** A check run for this gate: its answer, "checking" until it has one, or null if it failed. */
  readonly reachability: EnvironmentConnectReachability | "checking" | null;
}): McpGate {
  if (input.signedIn === undefined) return { kind: "checking" };
  if (!input.signedIn) return { kind: "sign-in" };
  const { relay } = input;
  if (!input.connected) {
    if (input.thisMachine) return { kind: "disconnected", relay: null };
    const availability = relay.status === "listed" ? relay.availability : undefined;
    // A refresh empties the list first, so wait for it instead of flashing "Connect first".
    if (relay.status === "loading" || availability === "checking") return { kind: "checking" };
    if (relay.status === "failed" || availability === "error") {
      return { kind: "disconnected", relay: "failed" };
    }
    return { kind: "disconnected", relay: availability === "offline" ? "offline" : null };
  }
  if (input.approvalCodes === undefined) return { kind: "checking" };
  if (!input.approvalCodes) return { kind: "update" };
  if (!input.canReadRelay) return { kind: "no-relay-read" };
  if (input.linkStateError !== null) return { kind: "error", message: input.linkStateError };
  const { linkState } = input;
  if (linkState === null) return { kind: "checking" };
  // This machine reports its own tunnel and the probe proves it; the list speaks for saved ones.
  const endpoint = !input.thisMachine && relay.status === "listed" ? relay.endpoint : undefined;
  if (!isManagedTunnelActive(linkState, endpoint?.providerKind)) return { kind: "turn-on" };
  if (!input.thisMachine) {
    if (relay.status === "loading") return { kind: "checking" };
    if (relay.status === "failed") return { kind: "error", message: "Could not reach T3 Connect." };
    if (endpoint === undefined) return { kind: "turn-on" };
  }
  const { reachability } = input;
  if (reachability === "checking") return { kind: "checking" };
  const mcpUrl = t3ConnectMcpUrl({
    thisMachine: input.thisMachine,
    tunnelHostname: linkState.tunnelHostname,
    relayEndpoint: endpoint,
  });
  if (reachability?.status === "reachable" && mcpUrl !== null) return { kind: "open", mcpUrl };
  return {
    kind: "offline",
    reachability: reachability?.status === "unreachable" ? reachability : null,
  };
}

/**
 * What a failed check request leaves: `prior` is the link state from before it, `latest` a read
 * after it (null when unread). The server may still have checked, so a result newer than `prior`
 * counts. Otherwise only a later server check does; with nothing read at all, only a retry does.
 */
export function afterFailedCheck(
  prior: EnvironmentCloudLinkStateResult | null,
  latest: EnvironmentCloudLinkStateResult | null,
): { readonly result: EnvironmentConnectReachability | null; readonly since: string | null } {
  const fresh = latest?.reachability;
  const known = prior?.reachability;
  if (
    fresh !== undefined &&
    prior !== null &&
    (known === undefined || fresh.checkedAt > known.checkedAt)
  ) {
    return { result: fresh, since: fresh.checkedAt };
  }
  const baseline = latest ?? prior;
  return {
    result: null,
    since: baseline === null ? null : (baseline.reachability?.checkedAt ?? ""),
  };
}

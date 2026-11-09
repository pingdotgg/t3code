import type {
  EnvironmentCloudLinkStateResult,
  EnvironmentConnectReachability,
} from "@t3tools/contracts";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";

import { isManagedTunnelActive, t3ConnectMcpUrl } from "~/cloud/t3ConnectState";

type Unreachable = Extract<EnvironmentConnectReachability, { readonly status: "unreachable" }>;

/**
 * What stands between the user and the wizard's steps. Only `open` lets them go on: cloud apps
 * need a public address, so the environment must answer on its T3 Connect tunnel.
 */
export type McpGate =
  | { readonly kind: "unavailable" }
  | { readonly kind: "checking" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "update" }
  | { readonly kind: "no-relay-read" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "turn-on" }
  | { readonly kind: "offline"; readonly reachability: Unreachable | null }
  | { readonly kind: "open"; readonly mcpUrl: string };

export function resolveMcpGate(input: {
  readonly cloudConfigured: boolean;
  /** Undefined until T3 Connect sign-in has loaded. */
  readonly signedIn: boolean | undefined;
  readonly connected: boolean;
  /** The environment's `mcpApprovalCodes` capability; undefined until its config loads. */
  readonly approvalCodes: boolean | undefined;
  readonly canReadRelay: boolean;
  readonly linkState: EnvironmentCloudLinkStateResult | null;
  readonly linkStateError: string | null;
  readonly relayEndpoint: RelayManagedEndpoint | undefined;
  /** A reachability check this gate started is still running. */
  readonly checking: boolean;
}): McpGate {
  if (!input.cloudConfigured) return { kind: "unavailable" };
  if (input.signedIn === undefined) return { kind: "checking" };
  if (!input.signedIn) return { kind: "sign-in" };
  if (!input.connected) return { kind: "disconnected" };
  if (input.approvalCodes === undefined) return { kind: "checking" };
  if (!input.approvalCodes) return { kind: "update" };
  if (!input.canReadRelay) return { kind: "no-relay-read" };
  if (input.linkStateError !== null) return { kind: "error", message: input.linkStateError };
  const linkState = input.linkState;
  if (linkState === null) return { kind: "checking" };
  if (!isManagedTunnelActive(linkState, input.relayEndpoint?.providerKind)) {
    return { kind: "turn-on" };
  }
  const reachability = linkState.reachability;
  const mcpUrl = t3ConnectMcpUrl(linkState, input.relayEndpoint);
  if (reachability?.status === "reachable" && mcpUrl !== null) return { kind: "open", mcpUrl };
  if (input.checking) return { kind: "checking" };
  return {
    kind: "offline",
    reachability: reachability?.status === "unreachable" ? reachability : null,
  };
}

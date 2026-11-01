import {
  type DesktopTailscalePeer,
  type DesktopTailscaleStatus,
  formatRoughDuration,
  type ServerTailscaleIssueCause,
  type ServerTailscaleStatus,
  t3ConnectTroubleshootingUrl,
  type T3ConnectTroubleshootingSection,
  tailscaleIssueHeadline,
  type TailscaleState,
} from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import {
  type ConnectionAttemptError,
  type ConnectionFailureCause,
  type ConnectionHop,
  type ConnectionRouteOutcome,
  failureDidNotAnswer,
  routeDidNotAnswer,
  type SupervisorConnectionState,
} from "./model.ts";
import { tailnetRefusalVerdict } from "./tailnet.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure, when one exists. */
  readonly moreInfoUrl: string | null;
  /** A tailnet policy grant the host says would let this device in, to paste. */
  readonly policySnippet: string | null;
}

/** This device's own Tailscale, when the platform can read it (desktop). */
export type LocalTailscaleStatus = Pick<DesktopTailscaleStatus, "state" | "peers">;

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  /**
   * The relay's last health check. For a relay-only environment it can name a
   * cause before any connect attempt; with other routes it is one more fact.
   */
  readonly relayStatus?: Pick<
    RelayEnvironmentStatusResponse,
    "status" | "endpointFailure" | "endpointStatus" | "offlineReason"
  > | null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
  /** Turns the Tailscale hint into a verdict on platforms that can read it. */
  readonly localTailscale?: LocalTailscaleStatus | null;
  /** The host's own Tailscale, as it last reported in its server config. */
  readonly hostTailscale?: ServerTailscaleStatus | null | undefined;
  readonly now?: number;
}

const TAILSCALE_TROUBLESHOOTING_URL =
  "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md#tailscale-troubleshooting";

const OFF_TAILNET_HINT = "Check that Tailscale is on for this device.";

/** Tailscale routes when every one of them failed to reach the host, else none. */
function failedTailnetRoutes(
  routes: ReadonlyArray<ConnectionRouteOutcome>,
): ReadonlyArray<ConnectionRouteOutcome> {
  const tailnet = routes.filter((route) => route.kind === "tailnet");
  return tailnet.every(routeDidNotAnswer) ? tailnet : [];
}

/** True when every Tailscale route failed, so this device's own Tailscale is worth reading. */
export function everyTailnetRouteFailed(state: SupervisorConnectionState): boolean {
  return failedTailnetRoutes(state.routes).length > 0;
}

/** The latest outcome on one route, for a route list. */
export function routeOutcomeText(outcome: ConnectionRouteOutcome): string {
  if (outcome.result === "answered") return "Answered";
  return routeDidNotAnswer(outcome) ? "Did not answer" : "Failed";
}

/**
 * A hint, not a verdict: every Tailscale route failed while another route
 * answered, so Tailscale may be off on this device. A host that is off fails
 * every route, so it gets no hint.
 */
export function offTailnetHint(state: SupervisorConnectionState): string | null {
  if (!everyTailnetRouteFailed(state)) return null;
  const otherAnswered = state.routes.some(
    (route) => route.kind !== "tailnet" && route.result === "answered",
  );
  return otherAnswered ? OFF_TAILNET_HINT : null;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause: ConnectionFailureCause | "offline" | "outdated" | "released" | null;
}

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set([
  "origin_unreachable",
  "invalid_response",
]);

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return { hop: unreachable && via === "relay" ? "tunnel" : "server", cause: null };
  }
  // With other routes, the relay's health says nothing about the route in use.
  const status = input.via === "relay" ? input.relayStatus : null;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline":
      return "This device is offline";
    case "outdated":
      return `${host} runs an older T3 Code`;
    case "clock_skew":
      return "This device's clock is off";
    case "not_linked":
      return `${host} is not linked to your T3 Connect account`;
    case "relay_error":
      return "T3 Connect returned an error";
    case "tunnel_pending":
      return `${host}'s tunnel is still being set up`;
    case "tunnel_not_enabled":
      return `T3 Connect is not turned on for ${host}`;
    case "released":
    case "tunnel_down":
      return `${host}'s tunnel is offline`;
    case "origin_unreachable":
      return `Tunnel works, but T3 Code on ${host} did not answer`;
    case "invalid_response":
      return `T3 Code on ${host} sent an unexpected answer`;
    case "dns":
      return `${host}'s tunnel address did not resolve`;
    case "tls":
      return `Secure connection to ${host}'s tunnel failed`;
    case "refused":
      return `${host}'s tunnel refused the connection`;
    case "timeout":
      return `${host} did not answer in time`;
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "This device could not prepare the connection";
    case "relay":
      return failure?.reason === "authentication"
        ? "T3 Connect did not accept this device's sign-in"
        : "This device can't reach T3 Connect";
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? `This device can't reach ${host}'s tunnel`
        : `T3 Connect could not reach ${host}'s tunnel`;
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `T3 Code on ${host} did not accept this device`
        : `T3 Code on ${host} did not answer`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  const checkHost = `On ${host}, check Settings > Sharing & access or run \`t3 connect status\`.`;
  switch (located.cause) {
    case "offline":
      return ["Connect this device to the internet. T3 Code reconnects on its own."];
    case "outdated":
      return [`Update T3 Code on ${host}.`];
    case "clock_skew":
      return [`Turn on automatic date and time on this device and on ${host}, then retry.`];
    case "not_linked":
      return [
        "Check that this device is signed in to the same T3 Connect account as the host.",
        `On ${host}, open Settings > Sharing & access and turn T3 Connect on.`,
      ];
    case "tunnel_pending":
      return ["Wait a minute. T3 Code retries on its own.", checkHost];
    case "relay_error":
      return [
        "Wait a few minutes. T3 Code retries on its own.",
        "If it keeps failing, copy the diagnostics and report it.",
      ];
    case "tunnel_not_enabled":
      return [`On ${host}, open Settings > Sharing & access and turn T3 Connect on.`];
    case "released":
    case "tunnel_down":
      return [
        `Make sure ${host} is awake and T3 Code is running on it.`,
        checkHost,
        `A VPN or Tailscale exit node on ${host} can block the tunnel (port 7844). Turn it off or allow the tunnel.`,
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [`Open or restart T3 Code on ${host}.`, checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [`Make sure ${host} is awake and online.`, checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        "Restart T3 Code on this device.",
        `If it keeps failing, remove ${host} from this device and add it again.`,
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? ["Sign out of T3 Connect and sign in again."]
        : [
            "Check this device's internet connection.",
            "A VPN, firewall, or ad blocker on this device can block T3 Connect.",
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            "A VPN, firewall, or DNS filter on this device can block the tunnel.",
            "Try another network, or add a direct route such as a Tailscale address.",
          ]
        : [`Make sure ${host} is awake and online.`, checkHost];
    case "server":
      return [
        `Make sure T3 Code is running on ${host}.`,
        "Retry. If it keeps failing, copy the diagnostics.",
      ];
  }
}

function helpSection(
  located: Located,
  failure: ConnectionAttemptError | null,
): T3ConnectTroubleshootingSection {
  switch (located.cause) {
    case "offline":
      return "this-device-cant-reach-t3-connect";
    case "outdated":
      return "the-host-runs-an-older-t3-code";
    case "clock_skew":
      return "the-clock-is-off";
    case "not_linked":
    case "tunnel_not_enabled":
      return "sign-in-account-or-link-problems";
    case "relay_error":
      return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending":
      return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response":
      return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return "the-t3-connect-address-does-not-resolve-or-answer";
    case null:
      break;
  }
  const onThisDevice =
    failure?.reason === "network" ||
    failure?.reason === "transport" ||
    failure?.reason === "timeout";
  switch (located.hop) {
    case "device":
      return "this-device-cant-reach-t3-connect";
    case "relay":
      return failure?.reason === "authentication"
        ? "sign-in-account-or-link-problems"
        : "this-device-cant-reach-t3-connect";
    case "tunnel":
      return onThisDevice ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? "sign-in-account-or-link-problems"
        : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "This device";
    case "relay":
      return "T3 Connect";
    case "tunnel":
      return `${host} tunnel`;
    case "server":
      return `T3 Code on ${host}`;
  }
}

/** Local states that rule out every Tailscale route from this device. */
function localTailscaleDown(
  state: TailscaleState | undefined,
): state is Exclude<TailscaleState, "running" | "unreadable"> {
  return state !== undefined && state !== "running" && state !== "unreadable";
}

/** Host issues that stop its Tailscale address from answering. */
const HOST_TAILSCALE_DOWN: ReadonlySet<ServerTailscaleIssueCause> = new Set([
  "not_running",
  "needs_login",
  "needs_machine_approval",
  "stopped",
  "key_expired",
]);

/** Also shown on a host's row; the rest only matter while setting up the host. */
const HOST_TAILSCALE_NOTICE: ReadonlySet<ServerTailscaleIssueCause> = new Set([
  ...HOST_TAILSCALE_DOWN,
  "key_expiring",
  "health_warning",
  "outdated",
  "no_ipv4",
  "userspace_networking",
]);

/** " (as of 2h ago)" for facts a minute old or more. */
function asOf(checkedAt: string, now: number): string {
  const age = now - Date.parse(checkedAt);
  return age >= 60_000 ? ` (as of ${formatRoughDuration(age)} ago)` : "";
}

/** The host's Tailscale problem as one headline and its fix, from the facts it last reported. */
export function hostTailscaleNotice(
  hostLabel: string,
  status: ServerTailscaleStatus | null | undefined,
  now: number,
  causes: ReadonlySet<ServerTailscaleIssueCause> = HOST_TAILSCALE_NOTICE,
): { readonly headline: string; readonly fix: string } | null {
  const issue = status?.issues.find((candidate) => causes.has(candidate.cause));
  if (status == null || issue === undefined) return null;
  return {
    headline: `${tailscaleIssueHeadline(hostLabel, issue, status.keyExpiry, now)}${asOf(status.checkedAt, now)}`,
    fix: `On ${hostLabel}: ${issue.fix}`,
  };
}

/**
 * The path to a peer, only while it is active. `relay` is the peer's home DERP
 * region even on a direct path, so it means DERP only without the others.
 */
function tailscalePeerPath(peer: DesktopTailscalePeer): string | null {
  if (!peer.active) return null;
  if (peer.curAddr !== null) return "direct";
  if (peer.peerRelay !== null) return "peer relay";
  return peer.relay !== null ? `DERP (${peer.relay})` : null;
}

// Peers list only IPv4 tailnet addresses, so an IPv6 route cannot be matched.
function routeHostname(address: string | null): string | null {
  if (address === null || !URL.canParse(address)) return null;
  const hostname = new URL(address).hostname.toLowerCase();
  return hostname.startsWith("[") ? null : hostname;
}

/**
 * The peer behind any of the failed routes, by tailnet address or MagicDNS
 * name. Undefined when no route has an address a peer could match.
 */
function routePeer(
  peers: ReadonlyArray<DesktopTailscalePeer>,
  routes: ReadonlyArray<ConnectionRouteOutcome>,
): DesktopTailscalePeer | null | undefined {
  const hostnames = new Set(routes.flatMap((route) => routeHostname(route.address) ?? []));
  if (hostnames.size === 0) return undefined;
  return (
    peers.find((peer) => {
      const dnsName = peer.magicDnsName?.toLowerCase();
      return (
        peer.tailnetAddresses.some((address) => hostnames.has(address)) ||
        (dnsName !== undefined &&
          (hostnames.has(dnsName) || hostnames.has(dnsName.split(".")[0] ?? "")))
      );
    }) ?? null
  );
}

function lastSeen(peer: DesktopTailscalePeer, now: number): string | null {
  return peer.lastSeen === null
    ? null
    : `last seen ${formatRoughDuration(now - Date.parse(peer.lastSeen))} ago`;
}

function peerFact(peer: DesktopTailscalePeer | null | undefined, now: number): string | null {
  if (peer === undefined) return null;
  if (peer === null) return "not on this device's tailnet";
  const detail = peer.online ? tailscalePeerPath(peer) : lastSeen(peer, now);
  return [peer.online ? "online" : "offline", detail].filter(Boolean).join(", ");
}

interface TailnetVerdict {
  readonly headline: string;
  readonly steps: ReadonlyArray<string>;
}

/** Why every Tailscale route failed: this device, then the host's report, then the peer list. */
function tailnetVerdict(
  input: ConnectionDiagnosisInput,
  routes: ReadonlyArray<ConnectionRouteOutcome>,
  now: number,
): TailnetVerdict {
  const host = input.hostLabel;
  const local = input.localTailscale;
  const awake = `Make sure ${host} is awake and T3 Code is running on it.`;
  if (localTailscaleDown(local?.state)) {
    return {
      headline: tailscaleIssueHeadline("this device", { cause: local.state, fix: "" }, null, now),
      steps: [
        local.state === "needs_machine_approval"
          ? "Approve this device at https://login.tailscale.com/admin/machines. T3 Code reconnects on its own."
          : "Turn on Tailscale on this device and sign in. T3 Code reconnects on its own.",
      ],
    };
  }
  const hostNotice = hostTailscaleNotice(host, input.hostTailscale, now, HOST_TAILSCALE_DOWN);
  if (hostNotice !== null) return { headline: hostNotice.headline, steps: [hostNotice.fix] };

  const generic =
    input.relayStatus?.status === "online"
      ? `${host} is online on T3 Connect, but its Tailscale address did not answer`
      : `${host} did not answer over Tailscale`;
  const peer = local?.state === "running" ? routePeer(local.peers, routes) : undefined;
  if (peer === undefined) {
    return {
      headline: generic,
      steps: [`Check that Tailscale is on and signed in on this device and on ${host}.`, awake],
    };
  }
  if (peer === null) {
    return {
      headline: `${host} is not on this device's tailnet`,
      steps: [`Sign in to the same tailnet on this device and on ${host}.`, awake],
    };
  }
  // Online means connected to Tailscale's control plane, not reachable from here.
  if (!peer.online) {
    const seen = lastSeen(peer, now);
    return {
      headline: `${host} is offline on your tailnet${seen === null ? "" : ` (${seen})`}`,
      steps: [`Make sure ${host} is awake and Tailscale is on.`],
    };
  }
  // A direct or peer-relay path means a handshake worked, so Tailscale reaches the host.
  const reached = peer.active && (peer.curAddr !== null || peer.peerRelay !== null);
  return {
    headline: reached ? `T3 Code on ${host} did not answer` : generic,
    steps: [awake, `Check that no firewall on ${host} blocks its port.`],
  };
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  // A direct route that did not answer, where every Tailscale route also failed.
  // A refusal from an earlier attempt says nothing once this device is offline.
  const refusal = located.hop === "server" ? failure?.tailnetRefusal : undefined;
  const tailnetRoutes =
    located.hop === "server" &&
    located.cause === null &&
    failure !== null &&
    failureDidNotAnswer(failure)
      ? failedTailnetRoutes(input.state.routes)
      : [];
  const tailnet = tailnetRoutes.length > 0;
  const local = input.localTailscale;
  const tailscaleOff = tailnet && localTailscaleDown(local?.state);
  const now = input.now ?? DateTime.toEpochMillis(DateTime.nowUnsafe());
  const relayPath =
    located.hop === "relay" ||
    located.hop === "tunnel" ||
    (failure === null && input.relayStatus?.status === "offline") ||
    (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(tailscaleOff ? "device" : located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result: index < failedIndex ? "ok" : index === failedIndex ? "failed" : "unchecked",
  }));

  // The relay health check only explains the state when no attempt has failed yet.
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", refusal ?? located.cause ?? failure?.reason);
  add("HTTP status", httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "Next retry",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", relayPath ? "T3 Connect" : "Direct");
  for (const route of tailnetRoutes) add("Failed route", `Tailscale ${route.address ?? ""}`.trim());
  if (tailnet) {
    add("Tailscale on this device", local?.state);
    if (local?.state === "running") {
      add("Tailscale peer", peerFact(routePeer(local.peers, tailnetRoutes), now));
    }
    const hostTailscale = input.hostTailscale;
    if (hostTailscale != null) {
      add("Tailscale on host", `${hostTailscale.state}${asOf(hostTailscale.checkedAt, now)}`);
    }
  }
  if (input.via !== "relay") add("T3 Connect", input.relayStatus?.status);
  add("App version", input.clientVersion);
  add("Host version", input.serverVersion);
  add("Error", refusal === undefined ? failure?.detail : undefined);
  add("Trace ID", failure?.traceId);

  const verdict =
    refusal !== undefined
      ? tailnetRefusalVerdict(host, refusal)
      : tailnet
        ? tailnetVerdict(input, tailnetRoutes, now)
        : null;
  return {
    headline: verdict?.headline ?? headline(host, located, failure),
    hops,
    steps: verdict?.steps ?? steps(host, located, failure),
    facts,
    moreInfoUrl:
      tailnet || refusal !== undefined
        ? TAILSCALE_TROUBLESHOOTING_URL
        : relayPath
          ? t3ConnectTroubleshootingUrl(helpSection(located, failure))
          : null,
    policySnippet: refusal === undefined ? null : (failure?.suggestedGrant ?? null),
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `T3 Code connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.policySnippet
      ? ["", "Grant to add to your tailnet policy:", diagnosis.policySnippet]
      : []),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}

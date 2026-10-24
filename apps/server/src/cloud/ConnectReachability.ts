import * as NodeNet from "node:net";

import {
  connectReachabilityHelpUrl,
  type EnvironmentConnectReachability,
  formatConnectReachable,
} from "@t3tools/contracts";
import { readTailscaleExitNode, type TailscaleExitNode } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, decodeRuntimeConfig } from "./config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

// cloudflared finds the edge through the SRV record `_v2-origintunneld._tcp.argotunnel.com`,
// which names these two hosts on port 7844. QUIC and HTTP/2 both use that port.
const TUNNEL_EDGE_HOSTS = ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"];
const TUNNEL_EDGE_PORT = 7844;
const EDGE_CONNECT_TIMEOUT = Duration.seconds(5);
const ENDPOINT_REQUEST_TIMEOUT = Duration.seconds(10);
// cloudflared registers several connections within a few seconds; they are one change.
const READINESS_CHANGE_DEBOUNCE = Duration.seconds(3);
// Readiness changes miss failures and recoveries past cloudflared (DNS, origin, edge errors).
const RECHECK_INTERVAL = Duration.minutes(5);

export type EndpointProbe =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "dns_failed" | "timeout" | "network_error" };

/** Everything one check learned. `null` means that step did not run. */
export interface ReachabilityFacts {
  readonly managedTunnelConfigured: boolean;
  readonly connector: ManagedEndpointRuntime.ConnectorFacts | null;
  readonly endpoint: EndpointProbe | null;
  readonly edgeReachable: boolean | null;
  readonly exitNode: TailscaleExitNode | null;
}

type Unreachable = Extract<EnvironmentConnectReachability, { status: "unreachable" }>;

function exitNodeHint(exitNode: TailscaleExitNode | null): string | null {
  if (!exitNode) return null;
  const name = exitNode.name ? ` "${exitNode.name}"` : "";
  return `Tailscale exit node${name} is on. Traffic to Cloudflare goes through it.`;
}

/** Turns what one check learned into the answer every surface shows. */
export function classifyReachability(
  facts: ReachabilityFacts,
  checkedAt: string,
): EnvironmentConnectReachability {
  const { connector, endpoint, exitNode } = facts;
  const fail = (
    cause: Unreachable["cause"],
    reason: string,
    fix: string,
    hint: string | null = null,
  ): Unreachable => ({ status: "unreachable", checkedAt, cause, reason, hint, fix });
  const restart = "Restart T3 Code. If it stays, run `t3 connect` again.";

  if (!facts.managedTunnelConfigured) {
    return fail(
      "not_linked",
      "The server has not set up a T3 Connect tunnel.",
      "Run `t3 connect`, then restart the server (`t3 service restart`) so it applies the link.",
    );
  }
  if (connector === null) {
    return fail(
      "connector_not_running",
      "The tunnel client (cloudflared) is not running.",
      "Restart T3 Code. If it stays down, check the server log for relay client errors.",
    );
  }
  const status = endpoint?.kind === "status" ? endpoint.status : null;
  if (status === 200) {
    return {
      status: "reachable",
      checkedAt,
      readyConnections: connector.readyConnections,
      protocol: connector.protocol,
      ...(connector.hostname ? { hostname: connector.hostname } : {}),
    };
  }
  // The edge test is TCP only. With QUIC connections up, a 502 from a working tunnel, or
  // DNS already failing, a failed TCP test would hide the real cause.
  if (
    facts.edgeReachable === false &&
    status !== 502 &&
    !(connector.readyConnections && connector.readyConnections > 0) &&
    endpoint?.kind !== "dns_failed"
  ) {
    return fail(
      "edge_unreachable",
      `Cloudflare's tunnel port (${TUNNEL_EDGE_PORT}) times out from this machine.`,
      exitNode
        ? `tailscale set --exit-node=   (or allow outbound ${TUNNEL_EDGE_PORT} on that network)`
        : `Allow outbound TCP and UDP port ${TUNNEL_EDGE_PORT}, or turn off the VPN or firewall that blocks it.`,
      exitNodeHint(exitNode) ?? "A VPN, proxy, or firewall may block it.",
    );
  }
  if (status === 502) {
    return fail(
      "origin_unreachable",
      "The tunnel is up, but it cannot reach the T3 server on this machine.",
      "Restart T3 Code so the tunnel uses the port the server listens on.",
    );
  }
  if (endpoint === null || connector.readyConnections === 0) {
    return fail(
      "connector_not_ready",
      "cloudflared has not connected to Cloudflare yet.",
      "Wait a minute. If it stays, check the network and the server log.",
    );
  }
  // Cloudflare answers 530 (error 1033) when the tunnel has no live connector.
  if (status === 530) {
    return fail(
      "no_connector",
      "Cloudflare has no live connection from this machine for the tunnel.",
      restart,
    );
  }
  if (status !== null) {
    return fail(
      "unexpected_response",
      `The T3 Connect address answered with HTTP ${status}.`,
      restart,
    );
  }
  return endpoint.kind === "dns_failed"
    ? fail(
        "dns_failed",
        "The T3 Connect address does not resolve from this machine.",
        "Check the DNS settings on this machine or its VPN.",
        exitNodeHint(exitNode),
      )
    : fail(
        "timeout",
        "The T3 Connect address did not answer from this machine.",
        "Check the network, VPN, or proxy on this machine.",
        exitNodeHint(exitNode),
      );
}

/** The loud diagnosis the CLI prints and the server logs. */
export function formatReachabilityFailure(result: Unreachable): string {
  return [
    "✕ T3 Connect is NOT reachable from other devices",
    `  ${result.reason}`,
    ...(result.hint ? [`  ${result.hint}`] : []),
    `  Fix: ${result.fix}`,
    `  More info: ${connectReachabilityHelpUrl(result.cause)}`,
  ].join("\n");
}

function hasErrorCode(error: unknown, codes: ReadonlySet<string>): boolean {
  let current = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string" && codes.has(current.code)) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"]);
const textDecoder = new TextDecoder();

const canOpenTcp = (host: string, port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host, port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resume(Effect.succeed(connected));
    };
    socket.setTimeout(Duration.toMillis(EDGE_CONNECT_TIMEOUT), () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    return Effect.sync(() => socket.destroy());
  });

export class ConnectReachability extends Context.Service<
  ConnectReachability,
  {
    /** Runs a check now. The server also runs one when the tunnel's readiness changes. */
    readonly check: Effect.Effect<EnvironmentConnectReachability>;
    readonly latest: Effect.Effect<Option.Option<EnvironmentConnectReachability>>;
  }
>()("t3/cloud/ConnectReachability") {}

const make = Effect.gen(function* () {
  const runtime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  // `order` ranks checks by start, so a slow older one cannot replace a newer result.
  // `tunnelConfig` is the config a result was checked against: after a relink the old
  // result names the old tunnel's host until the new connector triggers a check.
  const latestRef = yield* Ref.make(
    Option.none<{
      readonly order: number;
      readonly result: EnvironmentConnectReachability;
      readonly tunnelConfig: string | null;
    }>(),
  );
  const checkCounter = yield* Ref.make(0);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const readExitNode = readTailscaleExitNode.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.orElseSucceed(() => null),
  );

  const probeEndpoint = (hostname: string) =>
    httpClient.get(`https://${hostname}/.well-known/t3/environment`).pipe(
      Effect.map((response): EndpointProbe => ({ kind: "status", status: response.status })),
      Effect.scoped,
      Effect.timeoutOption(ENDPOINT_REQUEST_TIMEOUT),
      Effect.map(Option.getOrElse((): EndpointProbe => ({ kind: "timeout" }))),
      Effect.catch((error) =>
        Effect.succeed<EndpointProbe>({
          kind: hasErrorCode(error, DNS_ERROR_CODES) ? "dns_failed" : "network_error",
        }),
      ),
    );

  const readTunnelConfig = secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG).pipe(
    Effect.map(Option.match({ onNone: () => null, onSome: (bytes) => textDecoder.decode(bytes) })),
    Effect.orElseSucceed(() => null),
  );

  // Runs only inside the `ConnectReachability.check` span.
  const gatherFacts = Effect.fnUntraced(function* (tunnelConfig: string | null) {
    const managedTunnelConfigured = tunnelConfig !== null;
    const config = tunnelConfig ? Option.getOrNull(decodeRuntimeConfig(tunnelConfig)) : null;
    const connector = config ? yield* runtime.inspectConnector(config) : null;
    const endpoint =
      connector?.hostname && connector.readyConnections !== 0
        ? yield* probeEndpoint(connector.hostname)
        : null;
    const facts: ReachabilityFacts = {
      managedTunnelConfigured,
      connector,
      endpoint,
      edgeReachable: null,
      exitNode: null,
    };
    if (connector === null || (endpoint?.kind === "status" && endpoint.status === 200)) {
      return facts;
    }
    const [edgeResults, exitNode] = yield* Effect.all(
      [
        Effect.forEach(TUNNEL_EDGE_HOSTS, (host) => canOpenTcp(host, TUNNEL_EDGE_PORT), {
          concurrency: "unbounded",
        }),
        readExitNode,
      ],
      { concurrency: 2 },
    );
    return { ...facts, edgeReachable: edgeResults.some(Boolean), exitNode };
  });

  const check = Effect.gen(function* () {
    const order = yield* Ref.updateAndGet(checkCounter, (count) => count + 1);
    const tunnelConfig = yield* readTunnelConfig;
    const facts = yield* gatherFacts(tunnelConfig);
    const result = classifyReachability(facts, DateTime.formatIso(yield* DateTime.now));
    const previous = yield* Ref.modify(latestRef, (current) =>
      Option.isSome(current) && current.value.order > order
        ? [null, current]
        : [current, Option.some({ order, result, tunnelConfig })],
    );
    if (previous === null) return result;
    const changed = Option.match(previous, {
      onNone: () => true,
      onSome: ({ result: last }) =>
        last.status !== result.status ||
        (last.status === "unreachable" &&
          result.status === "unreachable" &&
          last.cause !== result.cause),
    });
    if (!changed || (result.status === "unreachable" && result.cause === "not_linked")) {
      return result;
    }
    if (result.status === "unreachable") {
      // A connector that has not connected yet is usually still starting; the
      // runtime restarts it, and an unreachable edge is reported as its own cause.
      const log = result.cause === "connector_not_ready" ? Effect.logWarning : Effect.logError;
      yield* log(`\n${formatReachabilityFailure(result)}`).pipe(
        Effect.annotateLogs({ cause: result.cause }),
      );
    } else {
      yield* Effect.logInfo(
        `T3 Connect is reachable from other devices. ${formatConnectReachable(result)}`,
      );
    }
    return result;
  }).pipe(Effect.withSpan("ConnectReachability.check"));

  yield* runtime.readinessChanged.pipe(
    Stream.debounce(READINESS_CHANGE_DEBOUNCE),
    Stream.runForEach(() => check),
    Effect.forkScoped,
  );
  yield* Effect.sleep(RECHECK_INTERVAL).pipe(
    Effect.andThen(check),
    Effect.forever,
    Effect.forkScoped,
  );

  return ConnectReachability.of({
    check,
    latest: Effect.gen(function* () {
      const latest = yield* Ref.get(latestRef);
      const tunnelConfig = yield* readTunnelConfig;
      return Option.flatMap(latest, (entry) =>
        entry.tunnelConfig === tunnelConfig ? Option.some(entry.result) : Option.none(),
      );
    }),
  });
});

export const layer = Layer.effect(ConnectReachability, make);

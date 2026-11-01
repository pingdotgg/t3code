import * as NodeNet from "node:net";

import {
  connectReachabilityHelpUrl,
  type EnvironmentConnectReachability,
  formatConnectReachable,
} from "@t3tools/contracts";
import { readTailscaleExitNode, type TailscaleExitNode } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG } from "./config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

// cloudflared finds the edge through the SRV record `_v2-origintunneld._tcp.argotunnel.com`,
// which names these two hosts on port 7844. QUIC and HTTP/2 both use that port.
const TUNNEL_EDGE_HOSTS = ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"];
const TUNNEL_EDGE_PORT = 7844;
const EDGE_CONNECT_TIMEOUT = Duration.seconds(5);
const ENDPOINT_REQUEST_TIMEOUT = Duration.seconds(10);
const ERROR_BODY_READ_TIMEOUT = Duration.seconds(2);
// cloudflared registers several connections within a few seconds; they are one change.
const READINESS_CHANGE_DEBOUNCE = Duration.seconds(3);
// Readiness changes miss failures and recoveries past cloudflared (DNS, origin, edge errors).
const RECHECK_INTERVAL = Duration.minutes(5);
// cloudflared can keep reporting ready connections the edge already dropped, so its
// own readiness watch never restarts it. A 530 can also be brief, so restart only once it
// lasts, and wait longer after each restart that did not help.
const DEAD_CONNECTOR_RESTART_AFTER = Duration.minutes(2);
const DEAD_CONNECTOR_RESTART_AFTER_MAX = Duration.hours(1);

export type EndpointProbe =
  | { readonly kind: "status"; readonly status: number; readonly cloudflareError?: string }
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
  const cloudflareError = endpoint.kind === "status" ? endpoint.cloudflareError : undefined;
  // Cloudflare answers 530 with error 1033 when the tunnel has no live connector. Other
  // codes, such as 1016 for a broken DNS record, are not fixed by restarting cloudflared.
  if (status === 530 && (cloudflareError === undefined || cloudflareError === "1033")) {
    return fail(
      "no_connector",
      "Cloudflare has no live connection from this machine for the tunnel.",
      restart,
    );
  }
  if (status !== null) {
    const code = cloudflareError === undefined ? "" : ` (Cloudflare error ${cloudflareError})`;
    return fail(
      "unexpected_response",
      `The T3 Connect address answered with HTTP ${status}${code}.`,
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
  const latestRef = yield* Ref.make(
    Option.none<{ readonly order: number; readonly result: EnvironmentConnectReachability }>(),
  );
  const checkCounter = yield* Ref.make(0);
  // Checks update this as they finish, even when a newer check already did. A dead streak
  // or a restart backoff that began before a healthy check no longer counts.
  const lastHealthyOrder = yield* Ref.make(0);
  const deadConnectorRef = yield* SynchronizedRef.make<{
    readonly streak: {
      readonly pid: number;
      readonly since: number;
      readonly order: number;
    } | null;
    readonly restartAfterMillis: number;
    readonly restartOrder: number;
  }>({
    streak: null,
    restartAfterMillis: Duration.toMillis(DEAD_CONNECTOR_RESTART_AFTER),
    restartOrder: 0,
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const readExitNode = readTailscaleExitNode.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.orElseSucceed(() => null),
  );

  const probeEndpoint = Effect.fn("ConnectReachability.probeEndpoint")(
    function* (hostname: string) {
      const response = yield* httpClient
        .get(`https://${hostname}/.well-known/t3/environment`, { acceptJson: true })
        .pipe(Effect.timeoutOption(ENDPOINT_REQUEST_TIMEOUT));
      if (Option.isNone(response)) return { kind: "timeout" } satisfies EndpointProbe;
      const { status } = response.value;
      if (status !== 530) return { kind: "status", status } satisfies EndpointProbe;
      // Cloudflare's error page is HTML unless the client accepts JSON, which carries
      // `"error_code":1033`. Clients that send no User-Agent get `error code: 1033`.
      const body = yield* response.value.text.pipe(
        Effect.timeoutOption(ERROR_BODY_READ_TIMEOUT),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      const code = /error[_ ]code"?:\s*(\d{4})/i.exec(Option.getOrElse(body, () => ""))?.[1];
      return (
        code === undefined
          ? { kind: "status", status }
          : { kind: "status", status, cloudflareError: code }
      ) satisfies EndpointProbe;
    },
    Effect.scoped,
    Effect.catch((error) =>
      Effect.succeed<EndpointProbe>({
        kind: hasErrorCode(error, DNS_ERROR_CODES) ? "dns_failed" : "network_error",
      }),
    ),
  );

  const gatherFacts = Effect.gen(function* () {
    const managedTunnelConfigured = Option.isSome(
      yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG).pipe(Effect.orElseSucceed(Option.none)),
    );
    const connector = managedTunnelConfigured ? yield* runtime.inspectConnector : null;
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

  const isLatest = (order: number) =>
    Ref.get(latestRef).pipe(
      Effect.map((latest) => Option.isNone(latest) || latest.value.order <= order),
    );

  // Runs inside the check span; the runtime restart has its own. Returns the streak a dead
  // connector just started and when to confirm it.
  const restartDeadConnector = Effect.fnUntraced(function* (
    facts: ReachabilityFacts,
    result: EnvironmentConnectReachability,
    order: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const { connector } = facts;
    const dead =
      result.status === "unreachable" &&
      result.cause === "no_connector" &&
      connector !== null &&
      (connector.readyConnections ?? 0) > 0
        ? connector
        : null;
    return yield* SynchronizedRef.modifyEffect(deadConnectorRef, (current) =>
      Effect.gen(function* () {
        const healthy = yield* Ref.get(lastHealthyOrder);
        const state = {
          streak: current.streak && current.streak.order > healthy ? current.streak : null,
          restartAfterMillis:
            current.restartOrder > healthy
              ? current.restartAfterMillis
              : Duration.toMillis(DEAD_CONNECTOR_RESTART_AFTER),
          restartOrder: current.restartOrder,
        };
        if (!(yield* isLatest(order))) return [null, state] as const;
        if (dead === null) return [null, { ...state, streak: null }] as const;
        if (state.streak?.pid !== dead.pid) {
          const started = { ...state, streak: { pid: dead.pid, since: now, order } };
          return [{ order, after: Duration.millis(state.restartAfterMillis) }, started] as const;
        }
        if (now - state.streak.since < state.restartAfterMillis) return [null, state] as const;
        // Checks can invalidate the streak while this request waits for the runtime's lock.
        const streakOrder = state.streak.order;
        const stillDead = Effect.gen(function* () {
          if (!(yield* isLatest(order))) return false;
          return (yield* Ref.get(lastHealthyOrder)) < streakOrder;
        });
        if (!(yield* runtime.restartConnector(dead.pid, stillDead))) {
          return [null, state] as const;
        }
        const restarted = {
          streak: null,
          restartAfterMillis: Math.min(
            state.restartAfterMillis * 2,
            Duration.toMillis(DEAD_CONNECTOR_RESTART_AFTER_MAX),
          ),
          restartOrder: order,
        };
        return [null, restarted] as const;
      }),
    );
  });

  const check: Effect.Effect<EnvironmentConnectReachability> = Effect.gen(function* () {
    const order = yield* Ref.updateAndGet(checkCounter, (count) => count + 1);
    const facts = yield* gatherFacts;
    const result = classifyReachability(facts, DateTime.formatIso(yield* DateTime.now));
    if (result.status === "reachable") {
      yield* Ref.update(lastHealthyOrder, (healthy) => Math.max(healthy, order));
    }
    const previous = yield* Ref.modify(latestRef, (current) =>
      Option.isSome(current) && current.value.order > order
        ? [null, current]
        : [current, Option.some({ order, result })],
    );
    if (previous === null) return result;
    const started = yield* restartDeadConnector(facts, result, order);
    // Nothing else would look again until the next periodic check.
    if (started !== null) {
      const confirm = SynchronizedRef.get(deadConnectorRef).pipe(
        Effect.flatMap(({ streak }) =>
          streak?.order === started.order ? Effect.suspend(() => check) : Effect.void,
        ),
      );
      yield* Effect.sleep(started.after).pipe(Effect.andThen(confirm), Effect.forkIn(scope));
    }
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
    latest: Ref.get(latestRef).pipe(Effect.map(Option.map(({ result }) => result))),
  });
});

export const layer = Layer.effect(ConnectReachability, make);

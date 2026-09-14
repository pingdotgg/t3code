import * as Cloudflare from "alchemy/Cloudflare";
import type { RuntimeContext } from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import RelayHub, {
  type RelayHubDiagnostics,
  relayConnectionRoleHeader,
  relayConnectorTicketHeader,
  relayConnectorTokenHeader,
  relayEndpointKeyHeader,
  relayPublicUrlHeader,
} from "./RelayHub.ts";
import { relayOwnsManagedEndpointZone } from "../deploymentConfig.ts";
import { ManagedEndpointZone, RelayDeploymentConfig } from "../zone.ts";
import {
  type RelayEdgeRoute,
  type RelayEndpointAddress,
  relayEdgeRouteSuffix,
  relayObjectName,
  resolveRelayEdgeRoute,
} from "./routing.ts";

export type EdgeShape = {
  readonly configureEndpoint: (
    address: RelayEndpointAddress,
    connectorToken: string,
    connectorLeaseId: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly revokeEndpoint: (
    address: RelayEndpointAddress,
    connectorLeaseId?: string,
  ) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly diagnosticsObject: (
    userKey: string,
  ) => Effect.Effect<RelayHubDiagnostics, never, RuntimeContext>;
};

/**
 * Optional number of hub objects to spread users over. Unset means one hub
 * per user. Changing it after rollout moves every user to a different hub,
 * which strands their configured connectors until they relink.
 */
export const RelayHubShardCount = Config.int("RELAY_HUB_SHARD_COUNT").pipe(Config.option);

export function makeRelayEdgeRuntime(
  resolveRoute: (url: URL) => RelayEdgeRoute | null,
  shardCount: number | undefined,
) {
  return Effect.gen(function* () {
    const hubs = yield* RelayHub;
    const hubFor = (userKey: string) => hubs.getByName(relayObjectName(userKey, shardCount));

    return {
      configureEndpoint: (
        address: RelayEndpointAddress,
        connectorToken: string,
        connectorLeaseId: string,
      ) =>
        hubFor(address.userKey).setConnectorConfiguration(
          address.endpointKey,
          connectorToken,
          connectorLeaseId,
        ),
      revokeEndpoint: (address: RelayEndpointAddress, connectorLeaseId?: string) =>
        hubFor(address.userKey).revokeConnector(address.endpointKey, connectorLeaseId),
      diagnosticsObject: (userKey: string) => hubFor(userKey).diagnostics(),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const source = request.source;
        if (!(source instanceof Request)) {
          return HttpServerResponse.text("Unsupported relay request", { status: 500 });
        }

        const url = new URL(source.url);
        const route = resolveRoute(url);
        if (route === null) {
          return HttpServerResponse.text("Unknown relay endpoint", { status: 404 });
        }
        const headers = new Headers(source.headers);
        headers.delete(relayConnectionRoleHeader);
        headers.delete(relayConnectorTicketHeader);
        headers.delete(relayConnectorTokenHeader);
        headers.delete(relayEndpointKeyHeader);
        headers.delete(relayPublicUrlHeader);
        headers.set(relayEndpointKeyHeader, route.endpointKey);
        const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
        if (route.kind === "connector") {
          if (isWebSocket) {
            const connectorTicket = url.searchParams.get("ticket");
            if (!connectorTicket) {
              return HttpServerResponse.text("Missing connector ticket", { status: 401 });
            }
            headers.set(relayConnectionRoleHeader, "connector");
            headers.set(relayConnectorTicketHeader, connectorTicket);
            url.searchParams.delete("ticket");
          } else if (request.method === "POST") {
            const authorization = headers.get("authorization");
            if (!authorization?.startsWith("Bearer ")) {
              return HttpServerResponse.text("Missing connector authorization", { status: 401 });
            }
            headers.set(relayConnectionRoleHeader, "connector_ticket");
            headers.set(relayConnectorTokenHeader, authorization.slice("Bearer ".length));
            headers.delete("authorization");
          } else {
            return HttpServerResponse.text("Expected connector ticket request", { status: 405 });
          }
        } else {
          headers.set(relayPublicUrlHeader, url.href);
          headers.set(relayConnectionRoleHeader, isWebSocket ? "client" : "http");
        }

        const forwarded = HttpServerRequest.fromWeb(
          new Request(url, {
            method: source.method,
            headers,
            ...(source.method === "GET" || source.method === "HEAD" || source.body === null
              ? {}
              : { body: source.body }),
          }),
        );
        return yield* hubFor(route.userKey).fetch(forwarded);
      }),
    };
  });
}

export class Edge extends Cloudflare.Worker<Edge, EdgeShape>()("RelayEdge") {}

export const EdgeLive = Edge.make(
  Effect.gen(function* () {
    const { stage, managedEndpointZoneName } = yield* RelayDeploymentConfig;
    const zone = yield* ManagedEndpointZone;
    const edgeRouteSuffix = relayEdgeRouteSuffix(stage, managedEndpointZoneName);
    return {
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      routes: [{ pattern: `*-${edgeRouteSuffix}/*`, zoneId: yield* zone.zoneId }],
    };
  }).pipe(Effect.orDie),
  Effect.gen(function* () {
    const { stage, managedEndpointZoneName } = yield* RelayDeploymentConfig;
    const edgeRouteSuffix = relayEdgeRouteSuffix(stage, managedEndpointZoneName);
    const zone = yield* ManagedEndpointZone;
    const shardCount = yield* RelayHubShardCount;

    if (relayOwnsManagedEndpointZone(stage)) {
      yield* Cloudflare.DNS.Record("RelayEdgeWildcardDns", {
        zoneId: zone.zoneId,
        name: `*.${managedEndpointZoneName}`,
        type: "AAAA",
        content: "100::",
        proxied: true,
      });
    }

    return yield* makeRelayEdgeRuntime(
      (url) =>
        resolveRelayEdgeRoute({
          hostname: url.hostname,
          pathname: url.pathname,
          edgeRouteSuffix,
        }),
      shardCount._tag === "Some" ? shardCount.value : undefined,
    );
  }),
);

export default EdgeLive;

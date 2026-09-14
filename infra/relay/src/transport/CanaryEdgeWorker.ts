import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import RelayHub from "./RelayHub.ts";
import { constantTimeStringEqual } from "./connectorTicket.ts";
import { type EdgeShape, makeRelayEdgeRuntime, RelayHubShardCount } from "./EdgeWorker.ts";
import { isRelayRouteKey, relayConnectorPath, relayObjectName } from "./routing.ts";

const CONTROL_PREFIX = "/__t3-relay-canary";
// The canary has no wildcard hostname, so the address comes from the URL:
// `/u/<userKey>/e/<endpointKey>/...`. The suffix is what the origin sees.
const ADDRESS_PATH = /^\/u\/([a-f0-9]{16})\/e\/([a-f0-9]{16})(\/.*)?$/u;

export class CanaryEdge extends Cloudflare.Worker<CanaryEdge, EdgeShape>()("RelayEdgeCanary") {}

function readAddress(url: URL): { userKey: string; endpointKey: string } | null {
  const userKey = url.searchParams.get("userKey");
  const endpointKey = url.searchParams.get("endpointKey");
  if (userKey === null || endpointKey === null) return null;
  if (!isRelayRouteKey(userKey) || !isRelayRouteKey(endpointKey)) return null;
  return { userKey, endpointKey };
}

export const CanaryEdgeLive = CanaryEdge.make(
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const hubs = yield* RelayHub;
    const controlToken = yield* Config.redacted("T3_RELAY_CANARY_CONTROL_TOKEN");
    const shardCount = yield* RelayHubShardCount;
    const relay = yield* makeRelayEdgeRuntime(
      (url) => {
        const match = ADDRESS_PATH.exec(url.pathname);
        if (match === null) return null;
        const [, userKey, endpointKey, rest] = match;
        url.pathname = rest ?? "/";
        return {
          kind: url.pathname === relayConnectorPath ? "connector" : "public",
          userKey: userKey!,
          endpointKey: endpointKey!,
        };
      },
      shardCount._tag === "Some" ? shardCount.value : undefined,
    );

    return {
      ...relay,
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const source = request.source;
        if (!(source instanceof Request)) {
          return HttpServerResponse.text("Unsupported relay request", { status: 500 });
        }
        const url = new URL(source.url);
        if (!url.pathname.startsWith(CONTROL_PREFIX)) {
          return yield* relay.fetch;
        }

        const presented = source.headers.get("authorization")?.replace(/^Bearer /u, "");
        if (
          presented === undefined ||
          !constantTimeStringEqual(Redacted.value(controlToken), presented)
        ) {
          return HttpServerResponse.text("Unauthorized", { status: 401 });
        }

        const address = readAddress(url);
        if (address === null) {
          return HttpServerResponse.text("Missing userKey or endpointKey", { status: 400 });
        }
        const hub = hubs.getByName(
          relayObjectName(
            address.userKey,
            shardCount._tag === "Some" ? shardCount.value : undefined,
          ),
        );
        if (url.pathname === `${CONTROL_PREFIX}/configure` && request.method === "POST") {
          const connectorToken = url.searchParams.get("connectorToken");
          const connectorLeaseId = url.searchParams.get("connectorLeaseId");
          if (!connectorToken || !connectorLeaseId) {
            return HttpServerResponse.text("Missing connectorToken or connectorLeaseId", {
              status: 400,
            });
          }
          yield* hub.setConnectorConfiguration(
            address.endpointKey,
            connectorToken,
            connectorLeaseId,
          );
          return HttpServerResponse.empty({ status: 204 });
        }
        if (url.pathname === `${CONTROL_PREFIX}/diagnostics` && request.method === "GET") {
          return yield* HttpServerResponse.json(yield* hub.diagnostics(), {
            headers: { "cache-control": "no-store" },
          });
        }
        if (url.pathname === `${CONTROL_PREFIX}/revoke` && request.method === "POST") {
          const connectorLeaseId = url.searchParams.get("connectorLeaseId") ?? undefined;
          return yield* HttpServerResponse.json({
            revoked: yield* hub.revokeConnector(address.endpointKey, connectorLeaseId),
          });
        }
        return HttpServerResponse.text("Unknown canary operation", { status: 404 });
      }),
    };
  }),
);

export default CanaryEdgeLive;

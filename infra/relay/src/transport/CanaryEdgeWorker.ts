import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import RelayEnvironment from "./RelayEnvironment.ts";
import { constantTimeStringEqual } from "./connectorTicket.ts";
import { type EdgeShape, makeRelayEdgeRuntime } from "./EdgeWorker.ts";
import { relayConnectorPath } from "./routing.ts";

const CONTROL_PREFIX = "/__t3-relay-canary";

export class CanaryEdge extends Cloudflare.Worker<CanaryEdge, EdgeShape>()("RelayEdgeCanary") {}

export const CanaryEdgeLive = CanaryEdge.make(
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-05-22",
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const environments = yield* RelayEnvironment;
    const endpointKey = yield* Config.string("T3_RELAY_CANARY_ENDPOINT_KEY");
    const connectorToken = yield* Config.redacted("T3_RELAY_CANARY_CONNECTOR_TOKEN");
    const connectorLeaseId = yield* Config.string("T3_RELAY_CANARY_CONNECTOR_LEASE_ID");
    const controlToken = yield* Config.redacted("T3_RELAY_CANARY_CONTROL_TOKEN");
    const relay = yield* makeRelayEdgeRuntime((url) => ({
      kind: url.pathname === relayConnectorPath ? "connector" : "public",
      endpointKey,
    }));

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

        const environment = environments.getByName(endpointKey);
        if (url.pathname === `${CONTROL_PREFIX}/configure` && request.method === "POST") {
          yield* environment.setConnectorConfiguration(
            Redacted.value(connectorToken),
            connectorLeaseId,
          );
          return HttpServerResponse.empty({ status: 204 });
        }
        if (url.pathname === `${CONTROL_PREFIX}/diagnostics` && request.method === "GET") {
          return yield* HttpServerResponse.json(yield* environment.diagnostics(), {
            headers: { "cache-control": "no-store" },
          });
        }
        if (url.pathname === `${CONTROL_PREFIX}/revoke` && request.method === "POST") {
          return yield* HttpServerResponse.json({
            revoked: yield* environment.revokeConnector(connectorLeaseId),
          });
        }
        return HttpServerResponse.text("Unknown canary operation", { status: 404 });
      }),
    };
  }),
);

export default CanaryEdgeLive;

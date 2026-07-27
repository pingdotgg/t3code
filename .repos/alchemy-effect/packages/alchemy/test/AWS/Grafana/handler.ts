import * as Grafana from "@/AWS/Grafana";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GrafanaTestFunction extends Lambda.Function<Lambda.Function>()(
  "GrafanaTestFunction",
) {}

/**
 * Ungated fixture: binds the account-level `ListVersions` capability, which
 * needs no live workspace — proving the BindingHttp scaffold (init + IAM
 * grant + runtime call) end-to-end at low cost. The workspace-scoped
 * bindings are exercised by the gated fixture in `workspace-handler.ts`.
 */
export default GrafanaTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const listVersions = yield* Grafana.ListVersions();

    const bound = { listVersions };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/versions") {
          const { grafanaVersions } = yield* listVersions();
          return yield* HttpServerResponse.json({
            versions: grafanaVersions ?? [],
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Grafana.ListVersionsHttp)),
);

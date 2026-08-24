import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding, toPromTime } from "./BindingHttp.ts";
import { GetSeries, type GetSeriesRequest } from "./GetSeries.ts";
import type { PrometheusSeries } from "./PrometheusTypes.ts";

export const GetSeriesHttp = Layer.effect(
  GetSeries,
  makeAmpWorkspaceHttpBinding({
    name: "GetSeries",
    iamActions: ["aps:GetSeries"],
    makeClient: (send) => (request: GetSeriesRequest) =>
      send({
        method: "GET",
        path: "api/v1/series",
        query: {
          "match[]": request.match,
          start:
            request.start !== undefined ? toPromTime(request.start) : undefined,
          end: request.end !== undefined ? toPromTime(request.end) : undefined,
        },
      }).pipe(Effect.map((data) => data as PrometheusSeries[])),
  }),
);

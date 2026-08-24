import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding } from "./BindingHttp.ts";
import {
  GetMetricMetadata,
  type GetMetricMetadataRequest,
} from "./GetMetricMetadata.ts";
import type { PrometheusMetricMetadata } from "./PrometheusTypes.ts";

export const GetMetricMetadataHttp = Layer.effect(
  GetMetricMetadata,
  makeAmpWorkspaceHttpBinding({
    name: "GetMetricMetadata",
    iamActions: ["aps:GetMetricMetadata"],
    makeClient: (send) => (request: GetMetricMetadataRequest) =>
      send({
        method: "GET",
        path: "api/v1/metadata",
        query: {
          metric: request.metric,
          limit:
            request.limit !== undefined ? String(request.limit) : undefined,
        },
      }).pipe(
        Effect.map(
          (data) => data as Record<string, PrometheusMetricMetadata[]>,
        ),
      ),
  }),
);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAmpWorkspaceHttpBinding, toPromTime } from "./BindingHttp.ts";
import {
  GetLabels,
  type GetLabelsClient,
  type GetLabelsRequest,
  type GetLabelValuesRequest,
} from "./GetLabels.ts";

const rangeParams = (request: GetLabelsRequest) => ({
  "match[]": request.match,
  start: request.start !== undefined ? toPromTime(request.start) : undefined,
  end: request.end !== undefined ? toPromTime(request.end) : undefined,
});

export const GetLabelsHttp = Layer.effect(
  GetLabels,
  makeAmpWorkspaceHttpBinding({
    name: "GetLabels",
    iamActions: ["aps:GetLabels"],
    makeClient: (send): GetLabelsClient => ({
      labelNames: (request: GetLabelsRequest = {}) =>
        send({
          method: "GET",
          path: "api/v1/labels",
          query: rangeParams(request),
        }).pipe(Effect.map((data) => data as string[])),
      labelValues: (request: GetLabelValuesRequest) =>
        send({
          method: "GET",
          path: `api/v1/label/${encodeURIComponent(request.label)}/values`,
          query: rangeParams(request),
        }).pipe(Effect.map((data) => data as string[])),
    }),
  }),
);

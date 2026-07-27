import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:ListIndicators`.
 *
 * Lists the indicators of compromise a finished investigation surfaced —
 * TTPs, impossible travel, new geolocations, related findings — the raw
 * material for an automated triage report. The graph ARN is injected from
 * the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.ListIndicatorsHttp)`.
 * @binding
 * @section Running Investigations
 * @example Read An Investigation's Indicators
 * ```typescript
 * // init
 * const listIndicators = yield* AWS.Detective.ListIndicators(graph);
 *
 * // runtime
 * const { Indicators } = yield* listIndicators({ InvestigationId: id });
 * ```
 */
export interface ListIndicators extends Binding.Service<
  ListIndicators,
  "AWS.Detective.ListIndicators",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.ListIndicatorsRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.ListIndicatorsResponse,
      detective.ListIndicatorsError
    >
  >
> {}
export const ListIndicators = Binding.Service<ListIndicators>(
  "AWS.Detective.ListIndicators",
);

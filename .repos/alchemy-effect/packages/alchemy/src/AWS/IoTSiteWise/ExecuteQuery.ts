import type * as sitewise from "@distilled.cloud/aws/iotsitewise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ExecuteQuery}.
 */
export interface ExecuteQueryRequest extends sitewise.ExecuteQueryRequest {}

/**
 * Runtime binding for `iotsitewise:ExecuteQuery` — run a SiteWise SQL
 * query across all asset models, assets, measurements, metrics, and
 * transforms in the account from a deployed Lambda or Task.
 *
 * The query surface is account-wide, so the binding grants the action on
 * `Resource: ["*"]` and takes no bound resource.
 *
 * @binding
 * @section Querying Asset Data with SQL
 * Provide the `ExecuteQueryHttp` implementation layer on the Function
 * effect, bind in the init phase (no resource argument), then call the
 * returned client at runtime.
 *
 * @example Find an Asset by Name
 * ```typescript
 * // init — account-level binding takes no resource
 * const executeQuery = yield* AWS.IoTSiteWise.ExecuteQuery();
 *
 * // runtime
 * const { rows } = yield* executeQuery({
 *   queryStatement:
 *     "SELECT asset_id, asset_name FROM asset WHERE asset_name = 'Pump1'",
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTSiteWise.ExecuteQueryHttp))
 * ```
 */
export interface ExecuteQuery extends Binding.Service<
  ExecuteQuery,
  "AWS.IoTSiteWise.ExecuteQuery",
  () => Effect.Effect<
    (
      request: ExecuteQueryRequest,
    ) => Effect.Effect<
      sitewise.ExecuteQueryResponse,
      sitewise.ExecuteQueryError
    >
  >
> {}
export const ExecuteQuery = Binding.Service<ExecuteQuery>(
  "AWS.IoTSiteWise.ExecuteQuery",
);

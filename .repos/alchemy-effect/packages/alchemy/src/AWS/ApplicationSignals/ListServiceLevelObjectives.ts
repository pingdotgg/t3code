import type * as appsignals from "@distilled.cloud/aws/application-signals";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `application-signals:ListServiceLevelObjectives`.
 *
 * Lists the service level objectives in this account, optionally filtered by
 * service key attributes, operation name, or dependency config. Provide the
 * implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServiceLevelObjectivesHttp)`.
 * @binding
 * @section Listing Service Level Objectives
 * @example List All SLOs
 * ```typescript
 * // init — account-level, no resource argument
 * const listSlos = yield* AWS.ApplicationSignals.ListServiceLevelObjectives();
 *
 * // runtime
 * const page = yield* listSlos({});
 * for (const slo of page.SloSummaries) {
 *   yield* Effect.log(`${slo.Name}: ${slo.Arn}`);
 * }
 * ```
 */
export interface ListServiceLevelObjectives extends Binding.Service<
  ListServiceLevelObjectives,
  "AWS.ApplicationSignals.ListServiceLevelObjectives",
  () => Effect.Effect<
    (
      request: appsignals.ListServiceLevelObjectivesInput,
    ) => Effect.Effect<
      appsignals.ListServiceLevelObjectivesOutput,
      appsignals.ListServiceLevelObjectivesError
    >
  >
> {}

export const ListServiceLevelObjectives =
  Binding.Service<ListServiceLevelObjectives>(
    "AWS.ApplicationSignals.ListServiceLevelObjectives",
  );

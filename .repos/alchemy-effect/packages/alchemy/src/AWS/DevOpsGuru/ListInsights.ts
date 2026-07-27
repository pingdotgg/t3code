import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:ListInsights`.
 *
 * Lists the account's insights filtered by status (ongoing, closed, or any within a time range) and type (reactive/proactive).
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListInsightsHttp)`.
 * @binding
 * @section Inspecting Insights
 * @example List Ongoing Insights
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listInsights = yield* AWS.DevOpsGuru.ListInsights();
 *
 * // runtime
 * const { ReactiveInsights } = yield* listInsights({
 *   StatusFilter: { Ongoing: { Type: "REACTIVE" } },
 * });
 * yield* Effect.log(`ongoing: ${ReactiveInsights?.length}`);
 * ```
 */
export interface ListInsights extends Binding.Service<
  ListInsights,
  "AWS.DevOpsGuru.ListInsights",
  () => Effect.Effect<
    (
      request: devopsguru.ListInsightsRequest,
    ) => Effect.Effect<
      devopsguru.ListInsightsResponse,
      devopsguru.ListInsightsError
    >
  >
> {}
export const ListInsights = Binding.Service<ListInsights>(
  "AWS.DevOpsGuru.ListInsights",
);

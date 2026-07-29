import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:ListEvents`.
 *
 * Lists the infrastructure and deployment events (CloudTrail changes, deployments, schema changes) DevOps Guru evaluated around an insight — the "what changed?" of an incident.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListEventsHttp)`.
 * @binding
 * @section Events and Recommendations
 * @example List Deployment Events Around an Insight
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listEvents = yield* AWS.DevOpsGuru.ListEvents();
 *
 * // runtime
 * const { Events } = yield* listEvents({
 *   Filters: { InsightId: insightId, DataSource: "AWS_CLOUD_TRAIL" },
 * });
 * yield* Effect.log(`events: ${Events?.length}`);
 * ```
 */
export interface ListEvents extends Binding.Service<
  ListEvents,
  "AWS.DevOpsGuru.ListEvents",
  () => Effect.Effect<
    (
      request: devopsguru.ListEventsRequest,
    ) => Effect.Effect<
      devopsguru.ListEventsResponse,
      devopsguru.ListEventsError
    >
  >
> {}
export const ListEvents = Binding.Service<ListEvents>(
  "AWS.DevOpsGuru.ListEvents",
);

import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:StartMonitoringMember`.
 *
 * Re-enables data ingest for a member account that was accepted but is
 * `ACCEPTED_BUT_DISABLED` (e.g. it previously blew the graph's volume
 * limit). The graph ARN is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.StartMonitoringMemberHttp)`.
 * @binding
 * @section Administering Member Accounts
 * @example Resume Ingest For A Member
 * ```typescript
 * // init
 * const startMonitoringMember =
 *   yield* AWS.Detective.StartMonitoringMember(graph);
 *
 * // runtime
 * yield* startMonitoringMember({ AccountId: "111122223333" });
 * ```
 */
export interface StartMonitoringMember extends Binding.Service<
  StartMonitoringMember,
  "AWS.Detective.StartMonitoringMember",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.StartMonitoringMemberRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.StartMonitoringMemberResponse,
      detective.StartMonitoringMemberError
    >
  >
> {}
export const StartMonitoringMember = Binding.Service<StartMonitoringMember>(
  "AWS.Detective.StartMonitoringMember",
);

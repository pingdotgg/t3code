import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ListSessions` — lists the bound cluster's interactive sessions, optionally filtered by state.
 * @binding
 * @section Interactive Sessions
 * @example List Idle Sessions
 * ```typescript
 * const listSessions = yield* AWS.EMR.ListSessions(cluster);
 *
 * const { Sessions } = yield* listSessions({ SessionStates: ["IDLE"] });
 * ```
 */
export interface ListSessions extends Binding.Service<
  ListSessions,
  "AWS.EMR.ListSessions",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListSessionsInput, "ClusterId">,
    ) => Effect.Effect<SVC.ListSessionsOutput, SVC.ListSessionsError>
  >
> {}
export const ListSessions = Binding.Service<ListSessions>(
  "AWS.EMR.ListSessions",
);

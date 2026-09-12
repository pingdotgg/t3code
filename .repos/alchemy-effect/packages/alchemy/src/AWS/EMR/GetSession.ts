import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:GetSession` — reads an interactive session of the bound cluster — state, engine configuration, and timeline.
 * ### Interactive Sessions
 * **Example:** Poll a Session's State
 * ```typescript
 * const getSession = yield* AWS.EMR.GetSession(cluster);
 *
 * const { Session } = yield* getSession({ SessionId: sessionId });
 * // Session.State: SUBMITTED | STARTING | IDLE | BUSY | …
 * ```
 *
 * @binding
 */
export interface GetSession extends Binding.Service<
  GetSession,
  "AWS.EMR.GetSession",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetSessionInput, "ClusterId">,
    ) => Effect.Effect<SVC.GetSessionOutput, SVC.GetSessionError>
  >
> {}
export const GetSession = Binding.Service<GetSession>("AWS.EMR.GetSession");

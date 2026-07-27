import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:TerminateSession` — terminates an interactive session on the bound cluster.
 * @binding
 * @section Interactive Sessions
 * @example Terminate a Session
 * ```typescript
 * const terminateSession = yield* AWS.EMR.TerminateSession(cluster);
 *
 * yield* terminateSession({ SessionId: sessionId });
 * ```
 */
export interface TerminateSession extends Binding.Service<
  TerminateSession,
  "AWS.EMR.TerminateSession",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.TerminateSessionInput, "ClusterId">,
    ) => Effect.Effect<SVC.TerminateSessionOutput, SVC.TerminateSessionError>
  >
> {}
export const TerminateSession = Binding.Service<TerminateSession>(
  "AWS.EMR.TerminateSession",
);

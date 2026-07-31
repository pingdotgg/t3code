import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:StartSession` — starts an interactive Spark Connect session on the bound cluster (EMR 7.8+ with sessions enabled).
 * @binding
 * @section Interactive Sessions
 * @example Start a Session
 * ```typescript
 * const startSession = yield* AWS.EMR.StartSession(cluster);
 *
 * const { Id } = yield* startSession({
 *   Name: "adhoc-analysis",
 *   ExecutionRoleArn: runtimeRoleArn,
 * });
 * ```
 */
export interface StartSession extends Binding.Service<
  StartSession,
  "AWS.EMR.StartSession",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.StartSessionInput, "ClusterId">,
    ) => Effect.Effect<SVC.StartSessionOutput, SVC.StartSessionError>
  >
> {}
export const StartSession = Binding.Service<StartSession>(
  "AWS.EMR.StartSession",
);

import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Namespace } from "./Namespace.ts";

/**
 * Runtime binding for the `RestoreFromRecoveryPoint` operation (IAM actions
 * `redshift-serverless:RestoreFromRecoveryPoint`).
 *
 * Restores the bound {@link Namespace} from an automatic recovery point —
 * point-in-time recovery within the last 24 hours. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.RestoreFromRecoveryPointHttp)`.
 * @binding
 * @section Restoring Data
 * @example Restore a Namespace from a Recovery Point
 * ```typescript
 * // init — resolve the runtime client
 * const restore = yield* AWS.RedshiftServerless.RestoreFromRecoveryPoint(namespace);
 *
 * yield* restore({ workgroupName, recoveryPointId });
 * ```
 */
export interface RestoreFromRecoveryPoint extends Binding.Service<
  RestoreFromRecoveryPoint,
  "AWS.RedshiftServerless.RestoreFromRecoveryPoint",
  (
    namespace: Namespace,
  ) => Effect.Effect<
    (
      request: Omit<
        serverless.RestoreFromRecoveryPointRequest,
        "namespaceName"
      >,
    ) => Effect.Effect<
      serverless.RestoreFromRecoveryPointResponse,
      serverless.RestoreFromRecoveryPointError
    >
  >
> {}
export const RestoreFromRecoveryPoint =
  Binding.Service<RestoreFromRecoveryPoint>(
    "AWS.RedshiftServerless.RestoreFromRecoveryPoint",
  );

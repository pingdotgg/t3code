import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `BatchGetEffectiveLifecyclePolicy` operation (IAM
 * action `aoss:BatchGetEffectiveLifecyclePolicy`; the action does not support
 * resource-level scoping, so the grant is on `*`).
 *
 * Resolves which retention {@link LifecyclePolicy} is in effect for specific
 * indexes (identified as `index/{collection}/{index}`). Indexes with no
 * effective policy are reported in `effectiveLifecyclePolicyErrorDetails`.
 * Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.BatchGetEffectiveLifecyclePolicyHttp)`.
 * @binding
 * @section Account Settings
 * @example Resolve an index's effective retention
 * ```typescript
 * const batchGetEffectiveLifecyclePolicy =
 *   yield* AWS.OpenSearchServerless.BatchGetEffectiveLifecyclePolicy();
 *
 * const response = yield* batchGetEffectiveLifecyclePolicy({
 *   resourceIdentifiers: [
 *     { type: "retention", resource: "index/logs/app-logs" },
 *   ],
 * });
 * const effective = response.effectiveLifecyclePolicyDetails?.[0];
 * yield* Effect.log(`retention: ${effective?.retentionPeriod}`);
 * ```
 */
export interface BatchGetEffectiveLifecyclePolicy extends Binding.Service<
  BatchGetEffectiveLifecyclePolicy,
  "AWS.OpenSearchServerless.BatchGetEffectiveLifecyclePolicy",
  () => Effect.Effect<
    (
      request: aoss.BatchGetEffectiveLifecyclePolicyRequest,
    ) => Effect.Effect<
      aoss.BatchGetEffectiveLifecyclePolicyResponse,
      aoss.BatchGetEffectiveLifecyclePolicyError
    >
  >
> {}
export const BatchGetEffectiveLifecyclePolicy =
  Binding.Service<BatchGetEffectiveLifecyclePolicy>(
    "AWS.OpenSearchServerless.BatchGetEffectiveLifecyclePolicy",
  );

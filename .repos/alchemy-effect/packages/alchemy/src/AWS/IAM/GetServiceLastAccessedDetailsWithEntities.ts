import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GetServiceLastAccessedDetailsWithEntities` — after
 * an access-advisor job generated for a *group or policy*, drill into which
 * member users/roles actually attempted to use a given service namespace.
 *
 * The `JobId` is produced at runtime, so the binding takes no arguments and
 * grants `iam:GetServiceLastAccessedDetailsWithEntities` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.IAM.GetServiceLastAccessedDetailsWithEntitiesHttp)`.
 *
 * @binding
 * @section Access Advisor
 * @example List the Entities That Used a Service
 * ```typescript
 * // init
 * const getDetailsWithEntities =
 *   yield* IAM.GetServiceLastAccessedDetailsWithEntities();
 *
 * // runtime
 * const { EntityDetailsList } = yield* getDetailsWithEntities({
 *   JobId: jobId,
 *   ServiceNamespace: "s3",
 * });
 * ```
 */
export interface GetServiceLastAccessedDetailsWithEntities extends Binding.Service<
  GetServiceLastAccessedDetailsWithEntities,
  "AWS.IAM.GetServiceLastAccessedDetailsWithEntities",
  () => Effect.Effect<
    (
      request: iam.GetServiceLastAccessedDetailsWithEntitiesRequest,
    ) => Effect.Effect<
      iam.GetServiceLastAccessedDetailsWithEntitiesResponse,
      iam.GetServiceLastAccessedDetailsWithEntitiesError
    >
  >
> {}
export const GetServiceLastAccessedDetailsWithEntities =
  Binding.Service<GetServiceLastAccessedDetailsWithEntities>(
    "AWS.IAM.GetServiceLastAccessedDetailsWithEntities",
  );

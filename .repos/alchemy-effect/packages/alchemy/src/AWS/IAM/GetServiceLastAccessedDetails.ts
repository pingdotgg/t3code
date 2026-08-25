import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GetServiceLastAccessedDetails` — poll and read the
 * access-advisor report started by {@link GenerateServiceLastAccessedDetails}:
 * job status plus, when `COMPLETED`, the per-service last-authenticated
 * timeline for the entity.
 *
 * The `JobId` is produced at runtime, so the binding takes no arguments and
 * grants `iam:GetServiceLastAccessedDetails` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.IAM.GetServiceLastAccessedDetailsHttp)`.
 *
 * @binding
 * @section Access Advisor
 * @example Read a Completed Access Report
 * ```typescript
 * // init
 * const getServiceLastAccessedDetails =
 *   yield* IAM.GetServiceLastAccessedDetails();
 *
 * // runtime
 * const report = yield* getServiceLastAccessedDetails({ JobId: jobId });
 * if (report.JobStatus === "COMPLETED") {
 *   const unused = report.ServicesLastAccessed?.filter(
 *     (s) => s.LastAuthenticated === undefined,
 *   );
 * }
 * ```
 */
export interface GetServiceLastAccessedDetails extends Binding.Service<
  GetServiceLastAccessedDetails,
  "AWS.IAM.GetServiceLastAccessedDetails",
  () => Effect.Effect<
    (
      request: iam.GetServiceLastAccessedDetailsRequest,
    ) => Effect.Effect<
      iam.GetServiceLastAccessedDetailsResponse,
      iam.GetServiceLastAccessedDetailsError
    >
  >
> {}
export const GetServiceLastAccessedDetails =
  Binding.Service<GetServiceLastAccessedDetails>(
    "AWS.IAM.GetServiceLastAccessedDetails",
  );

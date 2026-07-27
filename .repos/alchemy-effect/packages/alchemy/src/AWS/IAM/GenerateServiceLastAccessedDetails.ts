import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GenerateServiceLastAccessedDetails` — start an
 * access-advisor report for an IAM user, group, role, or policy, answering
 * "which services has this entity actually used?". Pair with
 * {@link GetServiceLastAccessedDetails} to poll the returned `JobId`.
 *
 * The target entity (`Arn`) is chosen per request — least-privilege tooling
 * typically iterates entities discovered at runtime — so the binding takes no
 * arguments and grants `iam:GenerateServiceLastAccessedDetails` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.IAM.GenerateServiceLastAccessedDetailsHttp)`.
 *
 * @binding
 * @section Access Advisor
 * @example Start an Access Report for a Role
 * ```typescript
 * // init
 * const generateServiceLastAccessedDetails =
 *   yield* IAM.GenerateServiceLastAccessedDetails();
 *
 * // runtime
 * const { JobId } = yield* generateServiceLastAccessedDetails({
 *   Arn: roleArn,
 * });
 * ```
 */
export interface GenerateServiceLastAccessedDetails extends Binding.Service<
  GenerateServiceLastAccessedDetails,
  "AWS.IAM.GenerateServiceLastAccessedDetails",
  () => Effect.Effect<
    (
      request: iam.GenerateServiceLastAccessedDetailsRequest,
    ) => Effect.Effect<
      iam.GenerateServiceLastAccessedDetailsResponse,
      iam.GenerateServiceLastAccessedDetailsError
    >
  >
> {}
export const GenerateServiceLastAccessedDetails =
  Binding.Service<GenerateServiceLastAccessedDetails>(
    "AWS.IAM.GenerateServiceLastAccessedDetails",
  );

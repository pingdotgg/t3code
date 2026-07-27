import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GenerateCredentialReport` — kick off generation of
 * the account-wide credential report (per-user password/key/MFA hygiene as
 * CSV). Pair with {@link GetCredentialReport} to retrieve the report once the
 * returned `State` is `COMPLETE`.
 *
 * Account-singleton operation: the binding takes no arguments and grants
 * `iam:GenerateCredentialReport` on `*`. Provide the implementation with
 * `Effect.provide(AWS.IAM.GenerateCredentialReportHttp)`.
 *
 * @binding
 * @section Credential Reports
 * @example Start a Credential Report
 * ```typescript
 * // init
 * const generateCredentialReport = yield* IAM.GenerateCredentialReport();
 *
 * // runtime
 * const { State } = yield* generateCredentialReport();
 * // "STARTED" | "INPROGRESS" | "COMPLETE"
 * ```
 */
export interface GenerateCredentialReport extends Binding.Service<
  GenerateCredentialReport,
  "AWS.IAM.GenerateCredentialReport",
  () => Effect.Effect<
    (
      request?: iam.GenerateCredentialReportRequest,
    ) => Effect.Effect<
      iam.GenerateCredentialReportResponse,
      iam.GenerateCredentialReportError
    >
  >
> {}
export const GenerateCredentialReport =
  Binding.Service<GenerateCredentialReport>("AWS.IAM.GenerateCredentialReport");

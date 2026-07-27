import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:GetCredentialReport` — download the account-wide
 * credential report started by {@link GenerateCredentialReport}. The report is
 * base64-encoded CSV of per-user credential hygiene (password age, key
 * rotation, MFA status); it contains no secret material.
 *
 * Retrieval before a report exists surfaces the typed
 * `CredentialReportNotPresentException` / `CredentialReportNotReadyException`
 * tags. Account-singleton operation: the binding takes no arguments and
 * grants `iam:GetCredentialReport` on `*`. Provide the implementation with
 * `Effect.provide(AWS.IAM.GetCredentialReportHttp)`.
 *
 * @binding
 * @section Credential Reports
 * @example Retrieve the Credential Report
 * ```typescript
 * // init
 * const getCredentialReport = yield* IAM.GetCredentialReport();
 *
 * // runtime
 * const report = yield* getCredentialReport().pipe(
 *   Effect.map((r) => new TextDecoder().decode(r.Content)),
 *   Effect.catchTag("CredentialReportNotPresentException", () =>
 *     Effect.succeed(undefined),
 *   ),
 * );
 * ```
 */
export interface GetCredentialReport extends Binding.Service<
  GetCredentialReport,
  "AWS.IAM.GetCredentialReport",
  () => Effect.Effect<
    (
      request?: iam.GetCredentialReportRequest,
    ) => Effect.Effect<
      iam.GetCredentialReportResponse,
      iam.GetCredentialReportError
    >
  >
> {}
export const GetCredentialReport = Binding.Service<GetCredentialReport>(
  "AWS.IAM.GetCredentialReport",
);

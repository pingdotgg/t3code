import type * as iam from "@distilled.cloud/aws/iam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iam:ListPoliciesGrantingServiceAccess` — list which
 * attached/inline policies grant an IAM user, group, or role access to given
 * service namespaces. The companion to access advisor for answering "*why*
 * can this entity reach that service?".
 *
 * The entity (`Arn`) is chosen per request, so the binding takes no arguments
 * and grants `iam:ListPoliciesGrantingServiceAccess` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.IAM.ListPoliciesGrantingServiceAccessHttp)`.
 *
 * @binding
 * @section Access Advisor
 * @example Explain a Role's S3 Access
 * ```typescript
 * // init
 * const listPoliciesGrantingServiceAccess =
 *   yield* IAM.ListPoliciesGrantingServiceAccess();
 *
 * // runtime
 * const { PoliciesGrantingServiceAccess } =
 *   yield* listPoliciesGrantingServiceAccess({
 *     Arn: roleArn,
 *     ServiceNamespaces: ["s3"],
 *   });
 * ```
 */
export interface ListPoliciesGrantingServiceAccess extends Binding.Service<
  ListPoliciesGrantingServiceAccess,
  "AWS.IAM.ListPoliciesGrantingServiceAccess",
  () => Effect.Effect<
    (
      request: iam.ListPoliciesGrantingServiceAccessRequest,
    ) => Effect.Effect<
      iam.ListPoliciesGrantingServiceAccessResponse,
      iam.ListPoliciesGrantingServiceAccessError
    >
  >
> {}
export const ListPoliciesGrantingServiceAccess =
  Binding.Service<ListPoliciesGrantingServiceAccess>(
    "AWS.IAM.ListPoliciesGrantingServiceAccess",
  );

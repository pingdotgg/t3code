import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `auditmanager:GetDelegations`.
 *
 * Lists the delegations assigned to the calling account. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetDelegationsHttp)`.
 * ### Delegations
 * **Example:** List the Account's Delegations
 * ```typescript
 * const getDelegations = yield* AWS.AuditManager.GetDelegations();
 * const result = yield* getDelegations({ maxResults: 20 });
 * ```
 *
 * @binding
 */
export interface GetDelegations extends Binding.Service<
  GetDelegations,
  "AWS.AuditManager.GetDelegations",
  () => Effect.Effect<
    (
      request?: auditmanager.GetDelegationsRequest,
    ) => Effect.Effect<auditmanager.GetDelegationsResponse, auditmanager.GetDelegationsError>
  >
> {}

export const GetDelegations = Binding.Service<GetDelegations>("AWS.AuditManager.GetDelegations");

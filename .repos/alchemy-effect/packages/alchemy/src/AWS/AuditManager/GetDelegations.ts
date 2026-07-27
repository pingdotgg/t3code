import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:GetDelegations`.
 *
 * Lists the delegations assigned to the calling account. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetDelegationsHttp)`.
 * @binding
 * @section Delegations
 * @example List the Account's Delegations
 * ```typescript
 * const getDelegations = yield* AWS.AuditManager.GetDelegations();
 * const result = yield* getDelegations({ maxResults: 20 });
 * ```
 */
export interface GetDelegations extends Binding.Service<
  GetDelegations,
  "AWS.AuditManager.GetDelegations",
  () => Effect.Effect<
    (
      request?: auditmanager.GetDelegationsRequest,
    ) => Effect.Effect<
      auditmanager.GetDelegationsResponse,
      auditmanager.GetDelegationsError
    >
  >
> {}

export const GetDelegations = Binding.Service<GetDelegations>(
  "AWS.AuditManager.GetDelegations",
);

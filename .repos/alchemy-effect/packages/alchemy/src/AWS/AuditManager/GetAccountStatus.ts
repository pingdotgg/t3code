import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:GetAccountStatus`.
 *
 * Gets the registration status of the account in Audit Manager
 * (`ACTIVE`, `INACTIVE`, or `PENDING_ACTIVATION`). Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetAccountStatusHttp)`.
 * @binding
 * @section Account Status
 * @example Guard on Audit Manager Registration
 * ```typescript
 * const getAccountStatus = yield* AWS.AuditManager.GetAccountStatus();
 * const result = yield* getAccountStatus();
 * ```
 */
export interface GetAccountStatus extends Binding.Service<
  GetAccountStatus,
  "AWS.AuditManager.GetAccountStatus",
  () => Effect.Effect<
    (
      request?: auditmanager.GetAccountStatusRequest,
    ) => Effect.Effect<
      auditmanager.GetAccountStatusResponse,
      auditmanager.GetAccountStatusError
    >
  >
> {}

export const GetAccountStatus = Binding.Service<GetAccountStatus>(
  "AWS.AuditManager.GetAccountStatus",
);

import type * as rolesanywhere from "@distilled.cloud/aws/rolesanywhere";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rolesanywhere:GetSubject`.
 *
 * Reads a *subject* — the audit record IAM Roles Anywhere keeps for each
 * certificate identity that has requested credentials, including the
 * certificates presented and the time of the last authentication attempt.
 * Account-level operation — subjects are chosen per request at runtime, so
 * the binding takes no resource argument. Provide the implementation with
 * `Effect.provide(AWS.RolesAnywhere.GetSubjectHttp)`.
 * @binding
 * @section Auditing Certificate Identities
 * @example Inspect a Subject's Credentials
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSubject = yield* AWS.RolesAnywhere.GetSubject();
 *
 * // runtime
 * const { subject } = yield* getSubject({ subjectId });
 * const lastSeen = subject?.lastSeenAt;
 * ```
 */
export interface GetSubject extends Binding.Service<
  GetSubject,
  "AWS.RolesAnywhere.GetSubject",
  () => Effect.Effect<
    (
      request: rolesanywhere.ScalarSubjectRequest,
    ) => Effect.Effect<
      rolesanywhere.SubjectDetailResponse,
      rolesanywhere.GetSubjectError
    >
  >
> {}
export const GetSubject = Binding.Service<GetSubject>(
  "AWS.RolesAnywhere.GetSubject",
);

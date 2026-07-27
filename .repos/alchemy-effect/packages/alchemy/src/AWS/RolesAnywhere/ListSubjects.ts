import type * as rolesanywhere from "@distilled.cloud/aws/rolesanywhere";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rolesanywhere:ListSubjects`.
 *
 * Lists the *subjects* — the audit records IAM Roles Anywhere keeps for each
 * certificate identity that has requested credentials in the account and
 * Region. The backbone of workload-identity auditing: which certificates
 * authenticated, and when they were last seen.
 * Account-level operation — the binding takes no resource argument. Provide
 * the implementation with `Effect.provide(AWS.RolesAnywhere.ListSubjectsHttp)`.
 * @binding
 * @section Auditing Certificate Identities
 * @example List Authenticated Subjects
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSubjects = yield* AWS.RolesAnywhere.ListSubjects();
 *
 * // runtime
 * const { subjects } = yield* listSubjects();
 * ```
 */
export interface ListSubjects extends Binding.Service<
  ListSubjects,
  "AWS.RolesAnywhere.ListSubjects",
  () => Effect.Effect<
    (
      request?: rolesanywhere.ListSubjectsRequest,
    ) => Effect.Effect<
      rolesanywhere.ListSubjectsResponse,
      rolesanywhere.ListSubjectsError
    >
  >
> {}
export const ListSubjects = Binding.Service<ListSubjects>(
  "AWS.RolesAnywhere.ListSubjects",
);

import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `GetChangeLogs` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetChangeLogsRequest extends Omit<
  auditmanager.GetChangeLogsRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetChangeLogs`.
 *
 * Lists the changelog — who did what, when — for the bound
 * assessment, optionally narrowed to a control set or control. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetChangeLogsHttp)`.
 * @binding
 * @section Audit Trail
 * @example Read the Assessment Changelog
 * ```typescript
 * const getChangeLogs = yield* AWS.AuditManager.GetChangeLogs(assessment);
 * const result = yield* getChangeLogs({ maxResults: 20 });
 * ```
 */
export interface GetChangeLogs extends Binding.Service<
  GetChangeLogs,
  "AWS.AuditManager.GetChangeLogs",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request?: GetChangeLogsRequest,
    ) => Effect.Effect<
      auditmanager.GetChangeLogsResponse,
      auditmanager.GetChangeLogsError
    >
  >
> {}

export const GetChangeLogs = Binding.Service<GetChangeLogs>(
  "AWS.AuditManager.GetChangeLogs",
);

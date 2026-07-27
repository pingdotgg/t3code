import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:ListKeywordsForDataSource`.
 *
 * Lists the keywords that are pre-mapped to the specified control
 * data source (CloudTrail event names, Config rules, Security Hub
 * controls, …). Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListKeywordsForDataSourceHttp)`.
 * @binding
 * @section Control Data Sources
 * @example Keywords for a Data Source
 * ```typescript
 * const listKeywordsForDataSource = yield* AWS.AuditManager.ListKeywordsForDataSource();
 * const result = yield* listKeywordsForDataSource({ source: "AWS_Cloudtrail" });
 * ```
 */
export interface ListKeywordsForDataSource extends Binding.Service<
  ListKeywordsForDataSource,
  "AWS.AuditManager.ListKeywordsForDataSource",
  () => Effect.Effect<
    (
      request: auditmanager.ListKeywordsForDataSourceRequest,
    ) => Effect.Effect<
      auditmanager.ListKeywordsForDataSourceResponse,
      auditmanager.ListKeywordsForDataSourceError
    >
  >
> {}

export const ListKeywordsForDataSource =
  Binding.Service<ListKeywordsForDataSource>(
    "AWS.AuditManager.ListKeywordsForDataSource",
  );

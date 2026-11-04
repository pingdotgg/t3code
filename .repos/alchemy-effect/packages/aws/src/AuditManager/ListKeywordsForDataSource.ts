import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `auditmanager:ListKeywordsForDataSource`.
 *
 * Lists the keywords that are pre-mapped to the specified control
 * data source (CloudTrail event names, Config rules, Security Hub
 * controls, …). Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListKeywordsForDataSourceHttp)`.
 * ### Control Data Sources
 * **Example:** Keywords for a Data Source
 * ```typescript
 * const listKeywordsForDataSource = yield* AWS.AuditManager.ListKeywordsForDataSource();
 * const result = yield* listKeywordsForDataSource({ source: "AWS_Cloudtrail" });
 * ```
 *
 * @binding
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

export const ListKeywordsForDataSource = Binding.Service<ListKeywordsForDataSource>(
  "AWS.AuditManager.ListKeywordsForDataSource",
);

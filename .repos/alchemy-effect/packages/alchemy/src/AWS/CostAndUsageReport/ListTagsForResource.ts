import type * as cur from "@distilled.cloud/aws/cost-and-usage-report-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReportDefinition } from "./ReportDefinition.ts";

/**
 * Runtime binding for `cur:ListTagsForResource` — read the tags on the bound
 * {@link ReportDefinition}. The report's name is injected automatically, so
 * the runtime callable takes no arguments.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.CostAndUsageReport.ListTagsForResourceHttp)`.
 * @binding
 * @section Reading Report Tags
 * @example List the tags on a report definition
 * ```typescript
 * // init — grants cur:ListTagsForResource on the report's ARN
 * const listReportTags =
 *   yield* AWS.CostAndUsageReport.ListTagsForResource(report);
 *
 * // runtime
 * const { Tags } = yield* listReportTags();
 * for (const tag of Tags ?? []) {
 *   yield* Effect.log(`${tag.Key}=${tag.Value}`);
 * }
 * ```
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.CostAndUsageReport.ListTagsForResource",
  (
    report: ReportDefinition,
  ) => Effect.Effect<
    () => Effect.Effect<
      cur.ListTagsForResourceResponse,
      cur.ListTagsForResourceError
    >
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.CostAndUsageReport.ListTagsForResource",
);

import * as cur from "@distilled.cloud/aws/cost-and-usage-report-service";
import * as Layer from "effect/Layer";
import { makeReportDefinitionHttpBinding } from "./BindingHttp.ts";
import { ListTagsForResource } from "./ListTagsForResource.ts";

/**
 * HTTP implementation of {@link ListTagsForResource}: grants
 * `cur:ListTagsForResource` on the bound report definition's ARN and calls
 * the us-east-1 CUR endpoint with the function's IAM credentials, injecting
 * the report's name as the `ReportName`.
 */
export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeReportDefinitionHttpBinding({
    capability: "ListTagsForResource",
    iamActions: ["cur:ListTagsForResource"],
    operation: cur.listTagsForResource,
  }),
);

import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { tagListRecord } from "../internal/Observe.ts";

/** The tags on one ELBv2 resource, as a record. */
export const readElbTags = Effect.fn(function* (resourceArn: string) {
  const described = yield* elbv2.describeTags({ ResourceArns: [resourceArn] });
  return tagListRecord(described.TagDescriptions?.[0]?.Tags);
});

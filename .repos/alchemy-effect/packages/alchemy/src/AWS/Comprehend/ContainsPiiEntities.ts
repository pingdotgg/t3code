import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ContainsPiiEntities` — check whether the
 * input text contains personally identifiable information, returning the
 * PII entity-type labels present (without offsets; use
 * {@link DetectPiiEntities} to locate them).
 *
 * The binding takes no arguments and grants the action on `*` (the action
 * has no resource-level IAM).
 *
 * @binding
 * @section Real-Time Analysis
 * @example Check a Document for PII
 * ```typescript
 * // init
 * const containsPiiEntities = yield* AWS.Comprehend.ContainsPiiEntities();
 *
 * // runtime
 * const result = yield* containsPiiEntities({
 *   Text: "My name is Jane Doe and my email is jane@example.com.",
 *   LanguageCode: "en",
 * });
 * // result.Labels: [{ Name: "NAME" }, { Name: "EMAIL" }]
 * ```
 */
export interface ContainsPiiEntities extends Binding.Service<
  ContainsPiiEntities,
  "AWS.Comprehend.ContainsPiiEntities",
  () => Effect.Effect<
    (
      request: comprehend.ContainsPiiEntitiesRequest,
    ) => Effect.Effect<
      comprehend.ContainsPiiEntitiesResponse,
      comprehend.ContainsPiiEntitiesError
    >
  >
> {}
export const ContainsPiiEntities = Binding.Service<ContainsPiiEntities>(
  "AWS.Comprehend.ContainsPiiEntities",
);

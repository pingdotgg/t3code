import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * Runtime binding for the `DescribeQuerySuggestionsConfig` operation (IAM action
 * `kendra:DescribeQuerySuggestionsConfig`), scoped to one {@link Index}.
 *
 * Reads the index's query-suggestions settings (mode, query-log look-back
 * window, attribute-suggestions config, …).
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.DescribeQuerySuggestionsConfigHttp)`.
 *
 * @binding
 * @section Query Suggestions
 * @example Read Suggestions Settings
 * ```typescript
 * const suggestionsConfig =
 *   yield* AWS.Kendra.DescribeQuerySuggestionsConfig(index);
 *
 * const config = yield* suggestionsConfig();
 * console.log(config.Mode, config.Status);
 * ```
 */
export interface DescribeQuerySuggestionsConfig extends Binding.Service<
  DescribeQuerySuggestionsConfig,
  "AWS.Kendra.DescribeQuerySuggestionsConfig",
  (
    index: Index,
  ) => Effect.Effect<
    () => Effect.Effect<
      kendra.DescribeQuerySuggestionsConfigResponse,
      kendra.DescribeQuerySuggestionsConfigError
    >
  >
> {}
export const DescribeQuerySuggestionsConfig =
  Binding.Service<DescribeQuerySuggestionsConfig>(
    "AWS.Kendra.DescribeQuerySuggestionsConfig",
  );

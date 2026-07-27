import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `UpdateQuerySuggestionsConfig` request with `IndexId` injected from the bound index.
 */
export interface UpdateQuerySuggestionsConfigRequest extends Omit<
  kendra.UpdateQuerySuggestionsConfigRequest,
  "IndexId" | "QueryLogLookBackWindowInDays"
> {
  /**
   * How far back in the index's query log Kendra looks for popular queries
   * when building suggestions. Accepts any duration input (e.g. `"14 days"`);
   * converted to whole days on the wire.
   */
  queryLogLookBackWindow?: Duration.Input;
}

/**
 * Runtime binding for the `UpdateQuerySuggestionsConfig` operation (IAM action
 * `kendra:UpdateQuerySuggestionsConfig`), scoped to one {@link Index}.
 *
 * Tunes the index's query-suggestions settings — switch between
 * `ENABLED` and `LEARN_ONLY`, adjust the query-log look-back window, or
 * change minimum query thresholds.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.UpdateQuerySuggestionsConfigHttp)`.
 *
 * @binding
 * @section Query Suggestions
 * @example Tune Suggestions
 * ```typescript
 * const updateSuggestions =
 *   yield* AWS.Kendra.UpdateQuerySuggestionsConfig(index);
 *
 * yield* updateSuggestions({
 *   Mode: "LEARN_ONLY",
 *   queryLogLookBackWindow: "14 days",
 *   MinimumNumberOfQueryingUsers: 2,
 * });
 * ```
 */
export interface UpdateQuerySuggestionsConfig extends Binding.Service<
  UpdateQuerySuggestionsConfig,
  "AWS.Kendra.UpdateQuerySuggestionsConfig",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request?: UpdateQuerySuggestionsConfigRequest,
    ) => Effect.Effect<
      kendra.UpdateQuerySuggestionsConfigResponse,
      kendra.UpdateQuerySuggestionsConfigError
    >
  >
> {}
export const UpdateQuerySuggestionsConfig =
  Binding.Service<UpdateQuerySuggestionsConfig>(
    "AWS.Kendra.UpdateQuerySuggestionsConfig",
  );

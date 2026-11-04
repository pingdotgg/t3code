import type * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GlossariesGlossaryEntry } from "./GlossariesGlossaryEntry.ts";

export interface GetGlossariesGlossaryEntryRequest extends Omit<
  translate.GetProjectsLocationsGlossariesGlossaryEntriesRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Translation `glossaryEntries.get`.
 *
 * Bind this operation to a {@link GlossariesGlossaryEntry} in a
 * Function/Action init phase. Provide {@link GetGlossariesGlossaryEntryHttp}.
 *
 * ### Reading an Entry
 * **Example:** Read the bound entry
 * ```typescript
 * const getEntry = yield* GCP.Translate.GetGlossariesGlossaryEntry(entry);
 * const live = yield* getEntry();
 * ```
 *
 * @binding
 * @category Translate
 */
export interface GetGlossariesGlossaryEntry extends Binding.Service<
  GetGlossariesGlossaryEntry,
  "GCP.Translate.GetGlossariesGlossaryEntry",
  (
    entry: GlossariesGlossaryEntry,
  ) => Effect.Effect<
    (
      request?: GetGlossariesGlossaryEntryRequest,
    ) => Effect.Effect<
      translate.GlossaryEntry,
      translate.GetProjectsLocationsGlossariesGlossaryEntriesError,
      RuntimeContext
    >
  >
> {}

export const GetGlossariesGlossaryEntry = Binding.Service<GetGlossariesGlossaryEntry>(
  "GCP.Translate.GetGlossariesGlossaryEntry",
);

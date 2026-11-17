import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Layer from "effect/Layer";
import { makeGlossaryEntryHttpBinding } from "./BindingHttp.ts";
import { GetGlossariesGlossaryEntry } from "./GetGlossariesGlossaryEntry.ts";

/**
 * HTTP implementation of {@link GetGlossariesGlossaryEntry}.
 *
 * @layer
 * @provides GCP.Translate.GetGlossariesGlossaryEntry
 */
export const GetGlossariesGlossaryEntryHttp = Layer.effect(
  GetGlossariesGlossaryEntry,
  makeGlossaryEntryHttpBinding({
    tag: "GCP.Translate.GetGlossariesGlossaryEntry",
    operation: translate.getProjectsLocationsGlossariesGlossaryEntries,
    iam: { role: "roles/cloudtranslate.viewer" },
  }),
);

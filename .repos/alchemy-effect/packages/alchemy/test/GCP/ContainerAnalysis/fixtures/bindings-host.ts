import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { TEST_ATTESTATION, TEST_RESOURCE_URI } from "../common.ts";

/** Note GetNote is granted on (roles/containeranalysis.notes.viewer). */
export const Authority = GCP.ContainerAnalysis.Note("Authority", {
  shortDescription: "binding attestor",
  attestation: { hint: { humanReadableName: "Alchemy Bind" } },
});

/** Occurrence GetOccurrence reads (roles/containeranalysis.occurrences.viewer). */
export const Signed = Effect.gen(function* () {
  const note = yield* Authority;
  return yield* GCP.ContainerAnalysis.Occurrence("Signed", {
    noteName: note.name,
    resourceUri: TEST_RESOURCE_URI,
    attestation: TEST_ATTESTATION,
  });
});

/**
 * Effect-native Cloud Run service exercising every Container Analysis
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ContainerAnalysisBindingsHost extends GCP.Function<ContainerAnalysisBindingsHost>()(
  "ContainerAnalysisBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getNote = yield* GCP.ContainerAnalysis.GetNote(Authority);
    const getOccurrence = yield* GCP.ContainerAnalysis.GetOccurrence(Signed);

    return {
      fetch: serveProbes({
        getNote: getNote(),
        getOccurrence: getOccurrence(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.ContainerAnalysis.GetNoteHttp),
    Effect.provide(GCP.ContainerAnalysis.GetOccurrenceHttp),
  ),
) {}

import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import * as Layer from "effect/Layer";
import { makeNoteHttpBinding } from "./BindingHttp.ts";
import { GetNote } from "./GetNote.ts";

/**
 * HTTP implementation of {@link GetNote}.
 *
 * @layer
 * @provides GCP.ContainerAnalysis.GetNote
 */
export const GetNoteHttp = Layer.effect(
  GetNote,
  makeNoteHttpBinding({
    tag: "GCP.ContainerAnalysis.GetNote",
    iam: {
      role: "roles/containeranalysis.notes.viewer",
      on: "containeranalysis.note",
    },
    operation: containeranalysis.getProjectsNotes,
  }),
);

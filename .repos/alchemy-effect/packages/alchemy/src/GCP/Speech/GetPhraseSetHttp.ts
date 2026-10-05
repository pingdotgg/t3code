import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Layer from "effect/Layer";
import { makePhraseSetHttpBinding } from "./BindingHttp.ts";
import { GetPhraseSet, type GetPhraseSetRequest } from "./GetPhraseSet.ts";

/**
 * HTTP implementation of {@link GetPhraseSet}.
 *
 * @layer
 * @provides GCP.Speech.GetPhraseSet
 */
export const GetPhraseSetHttp = Layer.effect(
  GetPhraseSet,
  makePhraseSetHttpBinding<
    speech.GetProjectsLocationsPhraseSetsRequest,
    speech.PhraseSet,
    speech.GetProjectsLocationsPhraseSetsError,
    GetPhraseSetRequest
  >({
    tag: "GCP.Speech.GetPhraseSet",
    operation: speech.getProjectsLocationsPhraseSets,
    iam: { role: "roles/speech.client" },
    toInput: (name) => ({ name }),
  }),
);

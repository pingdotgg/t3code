import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Layer from "effect/Layer";
import { makeCustomClassHttpBinding } from "./BindingHttp.ts";
import {
  GetCustomClass,
  type GetCustomClassRequest,
} from "./GetCustomClass.ts";

/**
 * HTTP implementation of {@link GetCustomClass}.
 *
 * @layer
 * @provides GCP.Speech.GetCustomClass
 */
export const GetCustomClassHttp = Layer.effect(
  GetCustomClass,
  makeCustomClassHttpBinding<
    speech.GetProjectsLocationsCustomClassesRequest,
    speech.CustomClass,
    speech.GetProjectsLocationsCustomClassesError,
    GetCustomClassRequest
  >({
    tag: "GCP.Speech.GetCustomClass",
    operation: speech.getProjectsLocationsCustomClasses,
    iam: { role: "roles/speech.client" },
    toInput: (name) => ({ name }),
  }),
);

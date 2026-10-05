import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Layer from "effect/Layer";
import { makePhraseSetHttpBinding } from "./BindingHttp.ts";
import { Recognize, type RecognizeRequest } from "./Recognize.ts";

/**
 * HTTP implementation of {@link Recognize}.
 *
 * @layer
 * @provides GCP.Speech.Recognize
 */
export const RecognizeHttp = Layer.effect(
  Recognize,
  makePhraseSetHttpBinding<
    speech.RecognizeSpeechRequest,
    speech.RecognizeResponse,
    speech.RecognizeSpeechError,
    RecognizeRequest
  >({
    tag: "GCP.Speech.Recognize",
    operation: speech.recognizeSpeech,
    iam: { role: "roles/speech.client" },
    toInput: (name, request) => {
      const body = request?.body ?? {};
      const config = body.config ?? {};
      const adaptation = config.adaptation ?? {};
      const references = [
        ...(adaptation.phraseSetReferences ?? []),
        name,
      ].filter((value, index, all) => all.indexOf(value) === index);
      return {
        body: {
          ...body,
          config: {
            ...config,
            adaptation: {
              ...adaptation,
              phraseSetReferences: references,
            },
          },
        },
      };
    },
  }),
);

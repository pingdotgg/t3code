import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { location } from "../common.ts";

export const Ships = GCP.Speech.CustomClass("BindShips", {
  location,
  items: [{ value: "sloop" }, { value: "schooner" }],
});

export const Hints = GCP.Speech.PhraseSet("BindHints", {
  location,
  phrases: [{ value: "weather" }],
});

/** ~0.1 s of 16 kHz LINEAR16 silence (3000 zero bytes, base64). */
const SILENCE = "A".repeat(4000);

/**
 * Effect-native Cloud Run service exercising every Speech-to-Text binding
 * as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class SpeechBindingsHost extends GCP.Function<SpeechBindingsHost>()(
  "SpeechBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getCustomClass = yield* GCP.Speech.GetCustomClass(Ships);
    const getPhraseSet = yield* GCP.Speech.GetPhraseSet(Hints);
    const recognize = yield* GCP.Speech.Recognize(Hints);

    return {
      fetch: serveProbes({
        getCustomClass: getCustomClass().pipe(
          Effect.map((customClass) => ({
            name: customClass.name,
            items: (customClass.items ?? []).map((item) => item.value),
          })),
        ),
        getPhraseSet: getPhraseSet().pipe(
          Effect.map((phraseSet) => ({
            name: phraseSet.name,
            phrases: (phraseSet.phrases ?? []).map((phrase) => phrase.value),
          })),
        ),
        recognize: recognize({
          body: {
            config: {
              languageCode: "en-US",
              encoding: "LINEAR16",
              sampleRateHertz: 16000,
            },
            audio: { content: SILENCE },
          },
        }).pipe(
          Effect.map((response) => ({
            results: response.results ?? [],
            totalBilledTime: response.totalBilledTime,
          })),
        ),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Speech.GetCustomClassHttp),
    Effect.provide(GCP.Speech.GetPhraseSetHttp),
    Effect.provide(GCP.Speech.RecognizeHttp),
  ),
) {}

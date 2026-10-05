import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Layer from "effect/Layer";
import { locationParentOf, makeTranslateTextBinding } from "./BindingHttp.ts";
import { TranslateText } from "./TranslateText.ts";

/**
 * HTTP implementation of {@link TranslateText}.
 *
 * @layer
 * @provides GCP.Translate.TranslateText
 */
export const TranslateTextHttp = Layer.effect(
  TranslateText,
  makeTranslateTextBinding({
    tag: "GCP.Translate.TranslateText",
    operation: translate.translateTextProjectsLocations,
    iam: { role: "roles/cloudtranslate.user" },
    withBody: (name, request) => ({
      parent: locationParentOf(name),
      body: {
        ...(request?.body ?? {}),
        model: name,
      },
    }),
  }),
);

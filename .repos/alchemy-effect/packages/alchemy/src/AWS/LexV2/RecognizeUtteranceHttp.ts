import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Layer from "effect/Layer";
import { makeLexAliasHttpBinding } from "./BindingHttp.ts";
import {
  RecognizeUtterance,
  type RecognizeUtteranceRequest,
} from "./RecognizeUtterance.ts";

/**
 * HTTP implementation of {@link RecognizeUtterance} — calls the
 * `lex-runtime-v2` `RecognizeUtterance` operation with the Lambda role's
 * credentials and grants the host `lex:RecognizeUtterance` on the alias.
 */
export const RecognizeUtteranceHttp = Layer.effect(
  RecognizeUtterance,
  makeLexAliasHttpBinding<
    RecognizeUtteranceRequest,
    lexr.RecognizeUtteranceResponse,
    lexr.RecognizeUtteranceError
  >({
    capability: "RecognizeUtterance",
    iamActions: ["lex:RecognizeUtterance"],
    operation: lexr.recognizeUtterance,
  }),
);

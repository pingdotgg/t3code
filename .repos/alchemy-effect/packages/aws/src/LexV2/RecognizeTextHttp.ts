import * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import * as Layer from "effect/Layer";
import { makeLexAliasHttpBinding } from "./BindingHttp.ts";
import { RecognizeText, type RecognizeTextRequest } from "./RecognizeText.ts";

/**
 * HTTP implementation of {@link RecognizeText} — calls the
 * `lex-runtime-v2` `RecognizeText` operation with the Lambda role's
 * credentials and grants the host `lex:RecognizeText` on the alias.
 */
export const RecognizeTextHttp = Layer.effect(
  RecognizeText,
  makeLexAliasHttpBinding<
    RecognizeTextRequest,
    lexr.RecognizeTextResponse,
    lexr.RecognizeTextError
  >({
    capability: "RecognizeText",
    iamActions: ["lex:RecognizeText"],
    operation: lexr.recognizeText,
  }),
);

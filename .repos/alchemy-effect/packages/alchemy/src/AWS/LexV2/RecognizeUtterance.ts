import type * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * The `RecognizeUtterance` request with the binding-injected `botId` and
 * `botAliasId` removed. `requestContentType` selects the input media type
 * (`text/plain; charset=utf-8` or an audio format) and `inputStream`
 * carries the user input. `sessionState`/`requestAttributes` must be
 * gzip-compressed and base64-encoded per the Lex V2 API contract.
 */
export interface RecognizeUtteranceRequest extends Omit<
  lexr.RecognizeUtteranceRequest,
  "botId" | "botAliasId"
> {}

/**
 * Runtime binding for `lex:RecognizeUtterance` — send user text or audio to
 * an Amazon Lex V2 bot alias. Unlike `RecognizeText`, the response's
 * `messages`/`sessionState`/`interpretations` come back gzip-compressed and
 * base64-encoded, and an `audioStream` reply is available for voice bots.
 *
 * @binding
 * @section Conversing with a Bot
 * @example Send a Text Utterance
 * ```typescript
 * // init
 * const recognizeUtterance = yield* AWS.LexV2.RecognizeUtterance(alias);
 *
 * // runtime — response fields are gzip+base64; decode before use
 * const reply = yield* recognizeUtterance({
 *   localeId: "en_US",
 *   sessionId: "user-123",
 *   requestContentType: "text/plain; charset=utf-8",
 *   inputStream: new TextEncoder().encode("hello"),
 * });
 * ```
 */
export interface RecognizeUtterance extends Binding.Service<
  RecognizeUtterance,
  "AWS.LexV2.RecognizeUtterance",
  (
    alias: BotAlias,
  ) => Effect.Effect<
    (
      request: RecognizeUtteranceRequest,
    ) => Effect.Effect<
      lexr.RecognizeUtteranceResponse,
      lexr.RecognizeUtteranceError
    >
  >
> {}

export const RecognizeUtterance = Binding.Service<RecognizeUtterance>(
  "AWS.LexV2.RecognizeUtterance",
);

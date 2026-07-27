import type * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * The `RecognizeText` request with the binding-injected `botId` and
 * `botAliasId` removed. `localeId` selects the conversation language and
 * `sessionId` identifies the conversation — both remain caller-supplied.
 */
export interface RecognizeTextRequest extends Omit<
  lexr.RecognizeTextRequest,
  "botId" | "botAliasId"
> {}

/**
 * Runtime binding for `lex:RecognizeText` — send user text to an Amazon Lex
 * V2 bot alias and receive the interpreted intent and response messages.
 *
 * The alias must point at a built bot version (see `BotVersion`).
 *
 * @binding
 * @section Conversing with a Bot
 * @example Recognize Text
 * ```typescript
 * // init
 * const recognizeText = yield* AWS.LexV2.RecognizeText(alias);
 *
 * // runtime
 * const reply = yield* recognizeText({
 *   localeId: "en_US",
 *   sessionId: "user-123",
 *   text: "hello",
 * });
 * const intent = reply.sessionState?.intent?.name;
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Bind the alias in the init phase, call in the handler, and provide
 * // the RecognizeTextHttp layer on the Function's init Effect.
 * export default ChatFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const alias = yield* AWS.LexV2.BotAlias("Live", {
 *       botId: version.botId,
 *       botVersion: version.botVersion,
 *     });
 *     const recognizeText = yield* AWS.LexV2.RecognizeText(alias);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const reply = yield* recognizeText({
 *           localeId: "en_US",
 *           sessionId: "user-123",
 *           text: "hello",
 *         });
 *         return HttpServerResponse.json({
 *           intent: reply.sessionState?.intent?.name ?? null,
 *         });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.LexV2.RecognizeTextHttp)),
 * );
 * ```
 */
export interface RecognizeText extends Binding.Service<
  RecognizeText,
  "AWS.LexV2.RecognizeText",
  (
    alias: BotAlias,
  ) => Effect.Effect<
    (
      request: RecognizeTextRequest,
    ) => Effect.Effect<lexr.RecognizeTextResponse, lexr.RecognizeTextError>
  >
> {}

export const RecognizeText = Binding.Service<RecognizeText>(
  "AWS.LexV2.RecognizeText",
);

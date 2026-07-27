import type * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * The `GetSession` request with the binding-injected `botId` and
 * `botAliasId` removed. `localeId` selects the conversation language and
 * `sessionId` identifies the conversation — both remain caller-supplied.
 */
export interface GetSessionRequest extends Omit<
  lexr.GetSessionRequest,
  "botId" | "botAliasId"
> {}

/**
 * Runtime binding for `lex:GetSession` — read the session state (active
 * intent, slots, session attributes, interpretations) of a conversation
 * with an Amazon Lex V2 bot alias.
 *
 * @binding
 * @section Managing Sessions
 * @example Inspect a User's Session
 * ```typescript
 * // init
 * const getSession = yield* AWS.LexV2.GetSession(alias);
 *
 * // runtime
 * const session = yield* getSession({
 *   localeId: "en_US",
 *   sessionId: "user-123",
 * });
 * const intent = session.sessionState?.intent?.name;
 * ```
 */
export interface GetSession extends Binding.Service<
  GetSession,
  "AWS.LexV2.GetSession",
  (
    alias: BotAlias,
  ) => Effect.Effect<
    (
      request: GetSessionRequest,
    ) => Effect.Effect<lexr.GetSessionResponse, lexr.GetSessionError>
  >
> {}

export const GetSession = Binding.Service<GetSession>("AWS.LexV2.GetSession");

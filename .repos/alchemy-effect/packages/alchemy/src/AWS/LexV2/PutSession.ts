import type * as lexr from "@distilled.cloud/aws/lex-runtime-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * The `PutSession` request with the binding-injected `botId` and
 * `botAliasId` removed. `sessionState` is the new state of the conversation
 * (active intent, slots, dialog action, session attributes).
 */
export interface PutSessionRequest extends Omit<
  lexr.PutSessionRequest,
  "botId" | "botAliasId"
> {}

/**
 * Runtime binding for `lex:PutSession` — create or overwrite the session
 * state of a conversation with an Amazon Lex V2 bot alias, letting your
 * application steer the dialog (e.g. pre-fill slots or elicit a specific
 * intent).
 *
 * @binding
 * @section Managing Sessions
 * @example Steer the Conversation
 * ```typescript
 * // init
 * const putSession = yield* AWS.LexV2.PutSession(alias);
 *
 * // runtime
 * yield* putSession({
 *   localeId: "en_US",
 *   sessionId: "user-123",
 *   sessionState: {
 *     intent: { name: "OrderPizza", slots: {} },
 *     dialogAction: { type: "ElicitSlot", slotToElicit: "Size" },
 *   },
 * });
 * ```
 */
export interface PutSession extends Binding.Service<
  PutSession,
  "AWS.LexV2.PutSession",
  (
    alias: BotAlias,
  ) => Effect.Effect<
    (
      request: PutSessionRequest,
    ) => Effect.Effect<lexr.PutSessionResponse, lexr.PutSessionError>
  >
> {}

export const PutSession = Binding.Service<PutSession>("AWS.LexV2.PutSession");

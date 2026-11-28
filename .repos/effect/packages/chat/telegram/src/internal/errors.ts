import {
  type Capability,
  ChatError,
  type ChatErrorReason,
  fileRefused,
  Forbidden,
  InvalidRequest,
  InvalidResponse,
  NotFound,
  PlatformUnavailable,
  RateLimited,
  TooLarge,
  Transport,
  Unauthenticated,
  Unknown,
  Unsupported
} from "effect/chat/ChatError"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { isObject } from "effect/Predicate"
import { platform } from "./address.ts"

/** @internal */
export const chatError = (op: string, reason: ChatErrorReason): ChatError => new ChatError({ platform, op, reason })

/** @internal */
export const fail = (op: string, reason: ChatErrorReason): Effect.Effect<never, ChatError> =>
  Effect.fail(chatError(op, reason))

/** @internal */
export const withOp = (op: string) => (error: ChatError): ChatError => chatError(op, error.reason)

/** @internal */
export const unsupported = (capability: Capability): ChatErrorReason => new Unsupported({ capability })

/** @internal */
export const invalidRequest = (detail: string): ChatErrorReason => new InvalidRequest({ detail })

/** @internal */
export const notFound = (detail: string): ChatErrorReason => new NotFound({ detail })

/** @internal */
export const tooLarge = (subject: "text" | "files" | undefined, detail: string): ChatErrorReason =>
  new TooLarge({ ...(subject === undefined ? {} : { subject }), detail })

/** @internal */
export const unauthenticatedToken: ChatErrorReason = new Unauthenticated({ detail: "invalid_token" })

/** @internal */
export const refusedFile: ChatErrorReason = new TooLarge({ subject: "files", detail: fileRefused })

/** The error Telegram answers with, without its description. @internal */
export interface ApiError {
  readonly code: number
  readonly description: string
  readonly retryAfter?: number | undefined
  readonly migrateTo?: number | undefined
}

/** The error in a body that says `ok: false`, or undefined. @internal */
export const apiError = (body: unknown, status: number): ApiError | undefined => {
  if (!isObject(body) || body.ok !== false) return undefined
  const parameters = isObject(body.parameters) ? body.parameters : {}
  return {
    code: typeof body.error_code === "number" ? body.error_code : status,
    description: typeof body.description === "string" ? body.description.toLowerCase() : "",
    ...(typeof parameters.retry_after === "number" ? { retryAfter: parameters.retry_after } : {}),
    ...(typeof parameters.migrate_to_chat_id === "number" ? { migrateTo: parameters.migrate_to_chat_id } : {})
  }
}

/**
 * Descriptions that refine a 400 or a 403, matched as substrings. Each gives
 * a fixed detail: a description can quote the message, so it never goes
 * into an error. The table grows from captured answers (live check 10).
 */
const refinements: ReadonlyArray<readonly [string, (detail: string) => ChatErrorReason, string]> = [
  ["message is not modified", invalidRequest, "not_modified"],
  ["message to edit not found", notFound, "message_not_found"],
  ["message to delete not found", notFound, "message_not_found"],
  ["message to be replied not found", notFound, "reply_target_not_found"],
  ["message not found", notFound, "message_not_found"],
  ["chat not found", notFound, "chat_not_found"],
  ["thread not found", notFound, "thread_not_found"],
  ["user not found", notFound, "user_not_found"],
  ["participant_id_invalid", notFound, "user_not_found"],
  ["message can't be deleted", (detail) => new Forbidden({ detail }), "cannot_delete"],
  ["message can't be edited", (detail) => new Forbidden({ detail }), "cannot_edit"],
  ["not enough rights", (detail) => new Forbidden({ detail }), "not_enough_rights"],
  ["have no rights", (detail) => new Forbidden({ detail }), "not_enough_rights"],
  ["bot was blocked", (detail) => new Forbidden({ detail }), "blocked"],
  ["bot was kicked", (detail) => new Forbidden({ detail }), "kicked"],
  ["bot is not a member", (detail) => new Forbidden({ detail }), "not_a_member"],
  // A rich message's limits, as live check 3 found them.
  ["rich_message_text_too_long", (detail) => tooLarge("text", detail), "message_too_long"],
  ["rich_message_too_large", (detail) => tooLarge("text", detail), "message_too_large"],
  ["rich_message_blocks_too_many", (detail) => tooLarge("text", detail), "too_many_blocks"],
  ["rich_message_depth_invalid", invalidRequest, "too_deep"],
  ["rich_message_table_cols_too_many", invalidRequest, "too_many_columns"],
  ["rich_message_empty", invalidRequest, "empty_message"],
  ["rich_message_markdown_invalid", invalidRequest, "invalid_markdown"],
  ["too long", (detail) => tooLarge("text", detail), "message_too_long"],
  ["file is too big", () => refusedFile, fileRefused],
  ["wrong file", () => refusedFile, fileRefused]
]

/** The detail of a chat that became a supergroup. @internal */
export const chatMigrated = "chat_migrated"

/**
 * Maps one Telegram error. `cause` is attached as given: the caller passes
 * nothing that holds a URL or message text.
 *
 * @internal
 */
export const reasonForApiError = (
  error: ApiError,
  options: { readonly write: boolean; readonly cause?: unknown }
): ChatErrorReason => {
  const cause = options.cause === undefined ? {} : { cause: options.cause }
  if (error.code === 429) {
    return new RateLimited({
      detail: "telegram_429",
      ...(error.retryAfter === undefined ? {} : { retryAfter: Duration.seconds(error.retryAfter) })
    })
  }
  if (error.migrateTo !== undefined) return new NotFound({ detail: chatMigrated, ...cause })
  if (error.code === 401 || error.code === 404) return new Unauthenticated({ detail: `telegram_${error.code}` })
  if (error.code >= 500) {
    return new PlatformUnavailable({ retry: options.write ? "uncertain" : "retry", detail: `telegram_${error.code}` })
  }
  if (error.code === 409) return invalidRequest("conflict")
  if (error.code === 400 || error.code === 403) {
    for (const [needle, make, detail] of refinements) {
      if (error.description.includes(needle)) return make(detail)
    }
    return error.code === 403 ? new Forbidden({ detail: "telegram_403" }) : invalidRequest("telegram_400")
  }
  return invalidRequest(`telegram_${error.code}`)
}

/** A request that failed before an answer came. A write may have landed. No cause: it would hold the URL. @internal */
export const transport = (write: boolean, detail: string): ChatErrorReason =>
  new Transport({ retry: write ? "uncertain" : "retry", detail })

/** An answer the adapter cannot read. A write may have landed. @internal */
export const invalidResponse = (write: boolean, detail: string): ChatErrorReason =>
  write ? new Unknown({ detail }) : new InvalidResponse({ detail })

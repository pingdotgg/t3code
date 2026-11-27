/**
 * The error every chat operation fails with.
 *
 * A `ChatError` records the platform and op, and holds one of twelve reasons.
 * Each reason has a three-way retry value: `retry` means nothing happened and
 * the request is safe to send again, `uncertain` means a write may or may not
 * have landed, and `denied` means sending again gives the same answer.
 *
 * **Details**
 *
 * - `detail` is redacted: a platform code such as `channel_not_found`, never
 *   message text, file names or ids. `file_refused` is fixed by the core: on
 *   a `denied` reason it promises a file was refused and nothing is left
 *   posted. It overrides platform error names; the original code stays on `cause`.
 * - `cause` is the error underneath (an HTTP error, a client library error, a
 *   `SchemaError`). It is unredacted and can hold URLs, ids and payload
 *   values. Schema encoding keeps it and `toJSON` leaves it out, so logging an
 *   error does not print it.
 *
 * @stability unstable
 * @since 4.1.5
 */
import type * as Duration from "../Duration.ts"
import * as Predicate from "../Predicate.ts"
import * as Schema from "../Schema.ts"

/**
 * Schema for the retry value of a chat error.
 *
 * **Details**
 *
 * - `retry`: nothing happened, safe to send again.
 * - `uncertain`: the write may or may not have landed. Adapters never retry it.
 * - `denied`: sending again gives the same answer.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Retry = Schema.Literals(["retry", "uncertain", "denied"])

/**
 * The retry value of a chat error.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Retry = typeof Retry.Type

/**
 * Schema for a capability name from `ChatAdapter.Descriptor`.
 *
 * **Details**
 *
 * - `buttons` covers buttons and link buttons, `selects` selects on a
 *   message, and `modals` opening a modal from a click or a command.
 * - `modalErrors` is field errors put back into an open modal. A platform
 *   without it answers `errors` some other way, so no op fails for it.
 * - `commands` is slash commands arriving, and `followUp` working.
 * - `ephemeral` is a command's answer that only the person who ran it sees.
 *   A platform with `commands` and without it refuses a private answer.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const Capability = Schema.Literals([
  "edit",
  "delete",
  "fetchMessage",
  "history",
  "download",
  "files",
  "replyTo",
  "startThread",
  "getThread",
  "opener",
  "getUser",
  "nativeStream",
  "buttons",
  "selects",
  "modals",
  "modalErrors",
  "commands",
  "ephemeral"
])

/**
 * A capability name from `ChatAdapter.Descriptor`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type Capability = typeof Capability.Type

/**
 * Detail for a refused file on any `denied` reason: nothing is left posted.
 *
 * @stability unstable
 * @category constants
 * @since 4.1.5
 */
export const fileRefused = "file_refused"

/**
 * Detail for a modal returned after the deadline: the reason is `NotFound`
 * and the op `openModal`.
 *
 * @stability unstable
 * @category constants
 * @since 4.1.5
 */
export const interactionExpired = "interaction_expired"

const detail = Schema.optionalKey(Schema.String)

const cause = Schema.optional(Schema.Defect())

const withoutCause = (json: unknown): unknown => {
  if (Predicate.isObject(json) && "cause" in json) {
    const { cause: _, ...rest } = json as Record<string, unknown>
    return rest
  }
  return json
}

const reasonMessage = (reason: { readonly _tag: string; readonly detail?: string | undefined }): string =>
  reason.detail === undefined ? reason._tag : `${reason._tag}: ${reason.detail}`

/**
 * Reason for a `ChatError`: the platform rate limited the request.
 *
 * **Details**
 *
 * Retry value `retry`: nothing happened. `retryAfter` is the wait the platform asked for, when it gave one.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class RateLimited extends Schema.TaggedError<RateLimited>("effect/chat/ChatError/RateLimited")("RateLimited", {
  retryAfter: Schema.optionalKey(Schema.Duration),
  detail,
  cause
}) {
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "retry"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for an `ChatError`: the platform has no equivalent for the op.
 *
 * **Details**
 *
 * Retry value `denied`. Every op exists on every platform and fails with this where the platform has no equivalent; `capability` names what is missing.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class Unsupported extends Schema.TaggedError<Unsupported>("effect/chat/ChatError/Unsupported")("Unsupported", {
  capability: Capability,
  detail,
  cause
}) {
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for a `ChatError`: the request failed in transport.
 *
 * **Details**
 *
 * Retry value `retry` when the request never left, `uncertain` when it did and no answer came.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class Transport extends Schema.TaggedError<Transport>("effect/chat/ChatError/Transport")("Transport", {
  retry: Retry,
  detail,
  cause
}) {
  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for a `ChatError`: the platform answered with a server error.
 *
 * **Details**
 *
 * Retry value `retry` for reads, `uncertain` for writes.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class PlatformUnavailable
  extends Schema.TaggedError<PlatformUnavailable>("effect/chat/ChatError/PlatformUnavailable")("PlatformUnavailable", {
    retry: Retry,
    detail,
    cause
  })
{
  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for a `ChatError`: no adapter is registered for the address's platform.
 *
 * **Details**
 *
 * Retry value `denied`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class NoAdapter extends Schema.TaggedError<NoAdapter>("effect/chat/ChatError/NoAdapter")("NoAdapter", {
  detail,
  cause
}) {
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for an `ChatError`: the platform refused the credentials: a bad or revoked token.
 *
 * **Details**
 *
 * Retry value `denied`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class Unauthenticated
  extends Schema.TaggedError<Unauthenticated>("effect/chat/ChatError/Unauthenticated")("Unauthenticated", {
    detail,
    cause
  })
{
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for a `ChatError`: the platform refused the request: a missing scope, not in the channel, an archived thread.
 *
 * **Details**
 *
 * Retry value `denied`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class Forbidden extends Schema.TaggedError<Forbidden>("effect/chat/ChatError/Forbidden")("Forbidden", {
  detail,
  cause
}) {
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for a `ChatError`: the thread, message, user or attachment is gone.
 *
 * **Details**
 *
 * Retry value `denied`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class NotFound extends Schema.TaggedError<NotFound>("effect/chat/ChatError/NotFound")("NotFound", {
  detail,
  cause
}) {
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for a `ChatError`: the request is past a size limit: message length, file size or `download`'s `maxBytes`.
 *
 * **Details**
 *
 * - Retry value `denied`.
 * - `subject` says what was too large, when the adapter can tell: `text` for
 *   the message text, `files` for the files sent with it. An adapter sets it
 *   on every refusal of `post`, `edit` and `NativeStream` it can attribute.
 * - Usually raised before the call. A platform-side size refusal carries
 *   the platform's error name in `detail`, unless a file was refused: then
 *   it is `file_refused`. `ChatMarkdown` keys its fallback on that detail,
 *   not on `subject`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class TooLarge extends Schema.TaggedError<TooLarge>("effect/chat/ChatError/TooLarge")("TooLarge", {
  subject: Schema.optionalKey(Schema.Literals(["text", "files"])),
  detail,
  cause
}) {
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for an `ChatError`: the platform refused the request as malformed.
 *
 * **Details**
 *
 * Retry value `denied`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class InvalidRequest
  extends Schema.TaggedError<InvalidRequest>("effect/chat/ChatError/InvalidRequest")("InvalidRequest", {
    detail,
    cause
  })
{
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for an `ChatError`: the platform answered with something the adapter cannot decode.
 *
 * **Details**
 *
 * Retry value `denied`.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class InvalidResponse
  extends Schema.TaggedError<InvalidResponse>("effect/chat/ChatError/InvalidResponse")("InvalidResponse", {
    detail,
    cause
  })
{
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "denied"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * Reason for an `ChatError`: the request failed for a reason the adapter cannot classify.
 *
 * **Details**
 *
 * Retry value `uncertain`: a write may or may not have landed.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class Unknown extends Schema.TaggedError<Unknown>("effect/chat/ChatError/Unknown")("Unknown", {
  detail,
  cause
}) {
  /**
   * The retry value of this reason, fixed per reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return "uncertain"
  }

  override get message(): string {
    return reasonMessage(this)
  }

  override toJSON(): unknown {
    return withoutCause(super.toJSON())
  }
}

/**
 * One of the twelve reasons a `ChatError` holds.
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export type ChatErrorReason =
  | RateLimited
  | Unsupported
  | Transport
  | PlatformUnavailable
  | NoAdapter
  | Unauthenticated
  | Forbidden
  | NotFound
  | TooLarge
  | InvalidRequest
  | InvalidResponse
  | Unknown

/**
 * Schema for the twelve reasons a `ChatError` holds.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ChatErrorReason: Schema.Union<[
  typeof RateLimited,
  typeof Unsupported,
  typeof Transport,
  typeof PlatformUnavailable,
  typeof NoAdapter,
  typeof Unauthenticated,
  typeof Forbidden,
  typeof NotFound,
  typeof TooLarge,
  typeof InvalidRequest,
  typeof InvalidResponse,
  typeof Unknown
]> = Schema.Union([
  RateLimited,
  Unsupported,
  Transport,
  PlatformUnavailable,
  NoAdapter,
  Unauthenticated,
  Forbidden,
  NotFound,
  TooLarge,
  InvalidRequest,
  InvalidResponse,
  Unknown
])

const TypeId = "~effect/chat/ChatError" as const

/**
 * The error every chat operation fails with.
 *
 * **Details**
 *
 * - `op` is the operation that failed: `post`, `edit`, `history` and so on.
 * - `cause` is the reason, so a failed span's stack trace carries the whole
 *   chain: the `ChatError`, the reason and the error under it.
 * - `retry` and `retryAfter` delegate to the reason.
 * - `message` is built from the platform, op, reason and `detail`, never from
 *   the cause.
 *
 * **Example** (Matching on a reason)
 *
 * ```ts import.meta.vitest
 * import { Effect } from "effect"
 * import { ChatError } from "effect/chat"
 *
 * const failing = Effect.fail(
 *   new ChatError.ChatError({
 *     platform: "slack",
 *     op: "post",
 *     reason: new ChatError.NotFound({ detail: "channel_not_found" })
 *   })
 * )
 *
 * const program = failing.pipe(
 *   Effect.catchReason("ChatError", "NotFound", (reason) => Effect.succeed(reason.detail))
 * )
 *
 * await Effect.runPromise(program) // => "channel_not_found"
 * ```
 *
 * @stability unstable
 * @category errors
 * @since 4.1.5
 */
export class ChatError extends Schema.TaggedError<ChatError>("effect/chat/ChatError")("ChatError", {
  platform: Schema.String,
  op: Schema.String,
  reason: ChatErrorReason
}) {
  /**
   * Marks the value as a `ChatError` for `isChatError`.
   *
   * @since 4.1.5
   */
  readonly [TypeId] = TypeId

  /**
   * The reason, so the chain under it ends up in a failed span's stack trace.
   *
   * @since 4.1.5
   */
  override readonly cause = this.reason

  /**
   * The retry value of the reason.
   *
   * @since 4.1.5
   */
  get retry(): Retry {
    return this.reason.retry
  }

  /**
   * The wait the platform asked for before a retry, when the reason is
   * `RateLimited` and it gave one.
   *
   * @since 4.1.5
   */
  get retryAfter(): Duration.Duration | undefined {
    return this.reason._tag === "RateLimited" ? this.reason.retryAfter : undefined
  }

  override get message(): string {
    return `${this.platform}.${this.op}: ${this.reason.message}`
  }

  override toJSON(): unknown {
    return {
      _tag: this._tag,
      platform: this.platform,
      op: this.op,
      reason: this.reason.toJSON()
    }
  }
}

/**
 * Returns whether a value is a `ChatError`.
 *
 * @stability unstable
 * @category guards
 * @since 4.1.5
 */
export const isChatError = (u: unknown): u is ChatError => Predicate.hasProperty(u, TypeId)

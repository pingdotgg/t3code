/**
 * Addresses for chat threads.
 *
 * A `ChatThread` names a channel, a thread or a direct conversation on one
 * platform. The address itself does not say which of the three it is:
 * `ChatEvent.MessageCreated.kind` and `Chat.getThread` do. The `id` is opaque
 * to the core and owned by the platform's adapter.
 *
 * @stability unstable
 * @since 4.1.5
 */
import * as Effect from "../Effect.ts"
import * as Option from "../Option.ts"
import * as Schema from "../Schema.ts"
import * as SchemaIssue from "../SchemaIssue.ts"
import * as SchemaTransformation from "../SchemaTransformation.ts"

/**
 * Schema for the address messages go to: a channel, a thread or a direct
 * conversation on one platform.
 *
 * **Details**
 *
 * `id` is opaque to the core and owned by the adapter. Slack's is
 * `{team}/{channel}` or `{team}/{channel}/{thread_ts}`, Discord's is the
 * channel snowflake.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const ChatThread = Schema.Struct({
  platform: Schema.String,
  id: Schema.String
}).annotate({ identifier: "ChatThread" })

/**
 * The address messages go to: a channel, a thread or a direct conversation on
 * one platform.
 *
 * @stability unstable
 * @category models
 * @since 4.1.5
 */
export type ChatThread = typeof ChatThread.Type

/**
 * Creates a thread address from a platform name and the adapter's id.
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.5
 */
export const make = (platform: string, id: string): ChatThread => ({ platform, id })

/**
 * Returns whether two thread addresses name the same platform and id.
 *
 * @stability unstable
 * @category comparisons
 * @since 4.1.5
 */
export const equals = (self: ChatThread, that: ChatThread): boolean =>
  self.platform === that.platform && self.id === that.id

/**
 * Formats a thread address as `{platform}:{id}`.
 *
 * **When to use**
 *
 * Use to build session keys, entity ids and URLs from an address.
 *
 * **Gotchas**
 *
 * The format is frozen once released, because consumers persist it.
 *
 * @see {@link fromString} for the inverse
 *
 * @stability unstable
 * @category converting
 * @since 4.1.5
 */
export const toString = (thread: ChatThread): string => `${thread.platform}:${thread.id}`

/**
 * Parses a `{platform}:{id}` string into a thread address.
 *
 * **Details**
 *
 * The platform is everything before the first `:`, so an id may contain
 * `:`. Both parts must be non-empty, otherwise the result is `None`.
 *
 * @see {@link toString} for the inverse
 *
 * @stability unstable
 * @category converting
 * @since 4.1.5
 */
export const fromString = (value: string): Option.Option<ChatThread> => {
  const index = value.indexOf(":")
  if (index <= 0 || index === value.length - 1) {
    return Option.none()
  }
  return Option.some(make(value.slice(0, index), value.slice(index + 1)))
}

/**
 * Schema that decodes a `{platform}:{id}` string into a `ChatThread` and
 * encodes it back.
 *
 * **Gotchas**
 *
 * The string format is frozen once released, because consumers persist it.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.5
 */
export const FromString: Schema.Codec<ChatThread, string> = Schema.String.pipe(
  Schema.decodeTo(
    ChatThread,
    SchemaTransformation.transformEffect<ChatThread, string>({
      decode: (value, options) =>
        Option.match(fromString(value), {
          onNone: () =>
            Effect.fail(new SchemaIssue.InvalidValue({ expected: "a {platform}:{id} string" }, value, options)),
          onSome: Effect.succeed
        }),
      encode: (thread) => Effect.succeed(toString(thread))
    })
  )
)

import type { ThreadKind } from "effect/chat/ChatEvent"
import * as ChatThread from "effect/chat/ChatThread"
import * as Option from "effect/Option"

/** @internal */
export const platform = "teams"

const replyChain = ";messageid="

/**
 * A Teams address is the Bot Framework conversation id as it is. A channel
 * thread is the channel's id with `;messageid={root}` after it.
 *
 * @internal
 */
export const thread = (conversationId: string): ChatThread.ChatThread => ChatThread.make(platform, conversationId)

/** @internal */
export interface Parts {
  /** The conversation id, as the Connector takes it. */
  readonly conversationId: string
  /** The conversation without a reply chain suffix. */
  readonly base: string
  /** The root message of a channel thread. */
  readonly root?: string | undefined
}

/** @internal */
export const parts = (address: ChatThread.ChatThread): Option.Option<Parts> => {
  if (address.platform !== platform || address.id.length === 0 || address.id.length > maxIdLength) {
    return Option.none()
  }
  const at = address.id.indexOf(replyChain)
  if (at === -1) return Option.some({ conversationId: address.id, base: address.id })
  const base = address.id.slice(0, at)
  const root = address.id.slice(at + replyChain.length)
  if (base.length === 0 || !/^\d+$/.test(root)) return Option.none()
  return Option.some({ conversationId: address.id, base, root })
}

/** The conversation id without its reply chain suffix. @internal */
export const baseConversation = (conversationId: string): string => {
  const at = conversationId.indexOf(replyChain)
  return at === -1 ? conversationId : conversationId.slice(0, at)
}

/** @internal */
export const threadOf = (base: string, root: string): ChatThread.ChatThread => thread(`${base}${replyChain}${root}`)

/** A personal chat: a one-to-one conversation with the bot. @internal */
export const isDirect = (conversationId: string): boolean => conversationId.startsWith("a:")

/** A team channel, as opposed to a group or personal chat. @internal */
export const isChannel = (conversationId: string): boolean =>
  /@thread\.(tacv2|skype)$/.test(baseConversation(conversationId))

/** @internal */
export const kind = (conversationId: string): ThreadKind =>
  conversationId.includes(replyChain) ? "thread" : isDirect(conversationId) ? "direct" : "channel"

/**
 * The longest id the adapter puts in a request: a conversation, message,
 * user or tenant id. A longer one fails `InvalidRequest` before the call.
 *
 * @internal
 */
export const maxIdLength = 256

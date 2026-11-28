import * as ChatThread from "effect/chat/ChatThread"
import * as Option from "effect/Option"

/** @internal */
export const platform = "telegram"

const chatId = /^-?[1-9]\d{0,15}$/
const topicId = /^[1-9]\d{0,9}$/

/** The address of a chat, or of a topic in it. @internal */
export const thread = (chat: string | number, messageThreadId?: string | number | undefined): ChatThread.ChatThread =>
  ChatThread.make(platform, messageThreadId === undefined ? String(chat) : `${chat}/${messageThreadId}`)

/** The parts of an address. @internal */
export interface Parts {
  readonly chatId: string
  readonly messageThreadId?: string | undefined
}

/** @internal */
export const parts = (address: ChatThread.ChatThread): Option.Option<Parts> => {
  if (address.platform !== platform) return Option.none()
  const [chat, topic, ...rest] = address.id.split("/")
  if (rest.length > 0 || !chatId.test(chat)) return Option.none()
  if (topic === undefined) return Option.some({ chatId: chat })
  return topicId.test(topic) ? Option.some({ chatId: chat, messageThreadId: topic }) : Option.none()
}

/** The prefix of the label a private answer's message id gets: `e{ephemeral_message_id}.{date}`. @internal */
export const ephemeralPrefix = "e"

/** A message or user id as Telegram takes it, or undefined. @internal */
export const numericId = (id: string): number | undefined => /^[1-9]\d{0,15}$/.test(id) ? Number(id) : undefined

/**
 * The conformance suite against the real Bot API. Opt-in: it runs only when
 * all three of these are set, so CI skips it.
 *
 * - `TELEGRAM_LIVE_BOT_TOKEN` and `TELEGRAM_LIVE_CHAT`: the bot and a group
 *   it may write to, as a chat id.
 * - `TELEGRAM_LIVE_BOT2_TOKEN`: a second bot in the group, for the rules
 *   that need another identity's message. Its message is sent with
 *   `sendMessage` and normalised as an inbound update, since bots never
 *   receive each other's messages.
 *
 * Only the default capabilities run: files, buttons and commands stay off
 * until their own live checks pass.
 */
import * as TelegramBotApi from "@effect/chat-telegram/TelegramBotApi"
import * as TelegramChat from "@effect/chat-telegram/TelegramChat"
import { describe, it } from "@effect/vitest"
import * as Chat from "effect/chat/Chat"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { conformance } from "effect/chat/ChatTest"
import type * as ChatThread from "effect/chat/ChatThread"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Semaphore from "effect/Semaphore"

const botToken = process.env.TELEGRAM_LIVE_BOT_TOKEN
const secondToken = process.env.TELEGRAM_LIVE_BOT2_TOKEN
const chat = process.env.TELEGRAM_LIVE_CHAT

describe.skipIf(botToken === undefined || secondToken === undefined || chat === undefined)("live conformance", () => {
  const layer = TelegramChat.layer({ token: Redacted.make(botToken!) }).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(FetchHttpClient.layer)
  )

  /** Posts as the second bot and normalises the answer as the update the first bot would get. */
  const userPosts = (thread: ChatThread.ChatThread, text: string): Effect.Effect<ChatEvent.ChatEvent> =>
    Effect.gen(function*() {
      const parts = TelegramChat.parts(thread)
      if (parts._tag === "None") return yield* Effect.die(new Error("not a Telegram thread"))
      const second = yield* TelegramBotApi.make({ token: Redacted.make(secondToken!) })
      const message = yield* second.call("sendMessage", {
        chat_id: Number(parts.value.chatId),
        ...(parts.value.messageThreadId === undefined
          ? {}
          : { message_thread_id: Number(parts.value.messageThreadId) }),
        text
      }, { write: true })
      const bot = yield* TelegramBotApi.TelegramBotApi
      const me = yield* bot.call("getMe")
      const events = TelegramChat.normalize({ update_id: 1, message }, {
        botId: bot.botId,
        botUsername: (me as { readonly username: string }).username
      })
      if (events.length !== 1) return yield* Effect.die(new Error("userPosts did not normalise to one event"))
      return events[0]
    }).pipe(Effect.provide(layer), Effect.provide(FetchHttpClient.layer), Effect.orDie)

  const rules = conformance({
    platform: "telegram",
    thread: TelegramChat.thread(chat ?? "0"),
    userPosts,
    parseMention: TelegramChat.parseMention
  })

  // The rules share one group and Telegram paces group writes, so one rule at a time.
  const one = Semaphore.makeUnsafe(1)
  for (const [name, rule] of Object.entries(rules)) {
    it.live(name, () => rule.pipe(Effect.provide(layer), Semaphore.withPermits(one, 1)), 600_000)
  }
})

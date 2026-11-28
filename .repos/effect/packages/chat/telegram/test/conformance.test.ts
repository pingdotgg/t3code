/**
 * The conformance suite against the adapter with every `unverified`
 * capability on, over a fake Bot API that keeps what was sent. Clicks and
 * commands are built from what was sent and go through
 * `TelegramChat.receive`.
 */
import * as TelegramChat from "@effect/chat-telegram/TelegramChat"
import { describe, it } from "@effect/vitest"
import { conformance } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import { makeApi, makeInteractions, telegramLayer, thread, userPosts } from "./utils.ts"

const options = { platform: "telegram", thread, userPosts, parseMention: TelegramChat.parseMention }

describe("conformance over a fake Bot API", () => {
  const names = Object.keys(conformance({
    ...options,
    interactions: { click: () => Effect.void, submit: () => Effect.void, command: () => Effect.void }
  }))

  for (const name of names) {
    it.effect(name, () => {
      const api = makeApi()
      const { bind, interactions } = makeInteractions(api)
      const rules = conformance({ ...options, interactions })
      return Effect.andThen(bind, rules[name]).pipe(Effect.provide(telegramLayer(api)))
    })
  }
})

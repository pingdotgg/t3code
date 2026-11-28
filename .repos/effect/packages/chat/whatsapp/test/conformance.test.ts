/**
 * The conformance suite against the adapter over a fake Graph API that keeps
 * what was sent. Clicks are built from the sent reply buttons and list rows
 * and go through `WhatsAppChat.receive`.
 */
import * as WhatsAppChat from "@effect/chat-whatsapp/WhatsAppChat"
import { describe, it } from "@effect/vitest"
import { conformance } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import { makeGraph, makeInteractions, thread, userPosts, whatsappLayer } from "./utils.ts"

const options = { platform: "whatsapp", thread, userPosts, parseMention: WhatsAppChat.parseMention }

describe("conformance over a fake Graph API", () => {
  const names = Object.keys(conformance({
    ...options,
    interactions: { click: () => Effect.void, submit: () => Effect.void }
  }))

  for (const name of names) {
    it.effect(name, () => {
      const graph = makeGraph()
      const { bind, interactions } = makeInteractions(graph)
      const rules = conformance({ ...options, interactions })
      return Effect.andThen(bind, rules[name]).pipe(Effect.provide(whatsappLayer(graph)))
    })
  }
})

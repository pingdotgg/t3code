import * as SlackChat from "@effect/chat-slack/SlackChat"
import { assert, describe, it } from "@effect/vitest"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { checkEvent } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import { botUserId, checkOptions, fixture, messageEnvelope, team } from "./utils.ts"

const context = { teamId: team, botUserId }

const created = (events: ReadonlyArray<ChatEvent.ChatEvent>): ChatEvent.MessageCreated => {
  assert.strictEqual(events.length, 1)
  const event = events[0]
  assert(event._tag === "MessageCreated")
  return event
}

const normalize = (message: Record<string, unknown>, options?: Parameters<typeof messageEnvelope>[1]) =>
  created(SlackChat.normalize(messageEnvelope(message, options), context))

const section = (
  elements: Array<unknown>
) => [{ type: "rich_text", elements: [{ type: "rich_text_section", elements }] }]

describe("normalize", () => {
  it.effect("without rich_text, text is scanned outside code", () =>
    Effect.gen(function*() {
      const event = normalize({
        ts: "1794509003.000001",
        user: "U080YLYB277",
        text: "hey <@U0CCLMD4S1L> `<@U999>` and <!here>"
      })
      yield* checkEvent(event, checkOptions)
      assert.deepStrictEqual(event.message.mentions.map((mention) => mention.id), [botUserId, "here"])
      assert.isTrue(event.message.mentions[0].isSelf)
    }))

  it.effect("text never adds a mention the rich_text block lacks", () =>
    Effect.gen(function*() {
      // Block items: literal U1, real U1, real U2, literal bot.
      const event = normalize({
        ts: "1794509003.000002",
        user: "U080YLYB277",
        text: `<@U1AAAA> <@U2BBBB> <@${botUserId}>`,
        blocks: section([
          { type: "text", text: "<@U1AAAA>" },
          { type: "user", user_id: "U1AAAA" },
          { type: "text", text: " " },
          { type: "user", user_id: "U2BBBB" },
          { type: "text", text: ` <@${botUserId}>` }
        ])
      })
      yield* checkEvent(event, checkOptions)
      assert.deepStrictEqual(
        event.message.mentions.map(({ id, isSelf, start }) => ({ id, isSelf, start })),
        [{ id: "U1AAAA", isSelf: false, start: 0 }, { id: "U2BBBB", isSelf: false, start: 10 }]
      )
    }))

  it.effect("a real mention with no token in text, past a literal, ends", () =>
    Effect.gen(function*() {
      // Block items: real U1, literal U9, real U2. Text has only U1.
      const event = normalize({
        ts: "1794509003.000004",
        user: "U080YLYB277",
        text: "<@U1AAAA>",
        blocks: section([
          { type: "user", user_id: "U1AAAA" },
          { type: "text", text: " <@U9ZZZZ> " },
          { type: "user", user_id: "U2BBBB" }
        ])
      })
      yield* checkEvent(event, checkOptions)
      assert.deepStrictEqual(event.message.mentions.map(({ id, start }) => ({ id, start })), [{
        id: "U1AAAA",
        start: 0
      }])
    }))

  it("files are attachments, with an id and no URL", () => {
    const reply = fixture("file-share").calls.flatMap((call) => call.response?.messages ?? [])
      .find((message: any) => message.ts === "1794509028.831169")
    assert.deepStrictEqual(normalize(reply).message.attachments, [{
      id: "F0CH6RHTMRU",
      name: "fixture.txt",
      contentType: "text/plain",
      size: 51
    }])
  })

  it("a D or mpim channel is a direct", () => {
    const message = { ts: "1794509003.000002", user: "U080YLYB277", text: "hi" }
    assert.strictEqual(normalize(message, { channel: "D0CCGDG0E75" }).kind, "direct")
    assert.strictEqual(normalize(message, { channel: "C0GROUP", channelType: "mpim" }).kind, "direct")
  })

  it("a bot_message's author is its bot_id", () => {
    const event = normalize({
      ts: "1794509003.000004",
      subtype: "bot_message",
      bot_id: "B0WEBHOOK",
      username: "incoming-webhook",
      text: "deploy done <@U0CCLMD4S1L>"
    })
    assert.deepStrictEqual(event.message.author, {
      id: "B0WEBHOOK",
      name: "incoming-webhook",
      isBot: true,
      isSelf: false
    })
  })

  it("drops other subtypes and other workspaces", () => {
    const message = { ts: "1794509003.000005", user: "U080YLYB277", text: "<@U0CCLMD4S1L>" }
    assert.deepStrictEqual(SlackChat.normalize(messageEnvelope({ ...message, subtype: "channel_join" }), context), [])
    assert.deepStrictEqual(SlackChat.normalize(messageEnvelope(message, { teamId: "T0OTHER" }), context), [])
  })

  it("drops the verification token from raw", () => {
    const event = normalize({ ts: "1794509003.000006", user: "U080YLYB277", text: "hi" })
    assert.isFalse("token" in (event.raw as object))
  })
})

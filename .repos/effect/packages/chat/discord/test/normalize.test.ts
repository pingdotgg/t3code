import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { assert, describe, it } from "@effect/vitest"
import type * as ChatEvent from "effect/chat/ChatEvent"
import * as ChatMessage from "effect/chat/ChatMessage"
import { checkEvent } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as fs from "node:fs"
import { botUserId, type Dispatch, events, guild, scratch, tim } from "./utils.ts"

const role = "1570607256838479964"
const checkOptions = { platform: "discord", parseMention: DiscordChat.parseMention }
const context = { botUserId }

const normalize = (dispatch: Dispatch): ReadonlyArray<ChatEvent.ChatEvent> => {
  const result = DiscordChat.normalize(dispatch, context)
  assert(Result.isSuccess(result), "expected events")
  return result.success
}

const created = (dispatch: Dispatch): ChatEvent.MessageCreated => {
  const [event, ...rest] = normalize(dispatch)
  assert(event._tag === "MessageCreated" && rest.length === 0)
  return event
}

const base = events("channel-message")[0]

describe("normalize", () => {
  it.effect("every recorded dispatch passes checkEvent", () =>
    Effect.gen(function*() {
      let count = 0
      for (const file of fs.readdirSync(new URL("./fixtures/events", import.meta.url))) {
        for (const dispatch of events(file.replace(/\.json$/, ""))) {
          const result = DiscordChat.normalize(dispatch, { ...context, channelType: 0 })
          assert(Result.isSuccess(result), file)
          for (const event of result.success) {
            yield* checkEvent(event, checkOptions)
            count++
          }
        }
      }
      assert.isAbove(count, 35)
    }))

  it("a MESSAGE_CREATE without channel_type fails MissingChannelType, then takes it from the context", () => {
    const dispatch = events("channel-message-without-channel-type")[0]
    const missing = DiscordChat.normalize(dispatch, context)
    assert(Result.isFailure(missing))
    assert.instanceOf(missing.failure, DiscordChat.MissingChannelType)
    assert.strictEqual(missing.failure.channelId, scratch)
    const kind = (dispatch: Dispatch, channelType: number) => {
      const result = DiscordChat.normalize(dispatch, { ...context, channelType })
      assert(Result.isSuccess(result) && result.success[0]._tag === "MessageCreated")
      return result.success[0].kind
    }
    assert.deepStrictEqual([kind(dispatch, 11), kind(dispatch, 1)], ["thread", "direct"])
    // The payload's own type wins over the context.
    assert.strictEqual(kind(base, 11), "channel")
  })

  it("a message with an invalid timestamp is dropped, not thrown", () => {
    assert.deepStrictEqual(normalize({ t: base.t, d: { ...base.d, timestamp: "not a date" } }), [])
  })

  it("THREAD_STARTER_MESSAGE and THREAD_CREATED give no event", () => {
    const dispatches = events("thread-started")
    assert.deepStrictEqual(dispatches.map((dispatch) => dispatch.d.type).sort(), [18, 21, 21])
    for (const dispatch of dispatches) assert.deepStrictEqual(normalize(dispatch), [])
  })

  it("a person's reply to the bot is a reply, not a mention, with the ping on or off", () => {
    const [pingOn, pingOff] = events("reply-ping").filter((dispatch) => dispatch.d.author.id === tim)
    const own = events("reply-ping").find((dispatch) => dispatch.d.author.id === botUserId)!
    const author = ({ id, isBot, isSelf }: ChatMessage.ChatMessage["author"]) => ({ id, isBot, isSelf })
    assert.deepStrictEqual(author(created(own).message.author), { id: botUserId, isBot: true, isSelf: true })
    // Discord lists the replied-to bot in mentions when the ping is on, with no token in content.
    assert.deepStrictEqual(pingOn.d.mentions.map((user: any) => user.id), [botUserId])
    assert.deepStrictEqual(pingOff.d.mentions, [])
    for (const dispatch of [pingOn, pingOff]) {
      const event = created(dispatch)
      assert.deepStrictEqual(author(event.message.author), { id: tim, isBot: false, isSelf: false })
      assert.deepStrictEqual(event.message.mentions, [])
      assert.isTrue(ChatMessage.repliesToSelf(event.message))
      assert.deepStrictEqual(Option.getOrThrow(DiscordChat.member(event)).roles, dispatch.d.member.roles)
    }
  })

  describe("mentions", () => {
    const mentionsOf = (event: ChatEvent.MessageCreated) =>
      event.message.mentions.map((mention) => ({
        kind: mention.kind,
        id: mention.id,
        isSelf: mention.isSelf,
        token: event.message.text.slice(mention.start, mention.end)
      }))
    const cases: ReadonlyArray<
      readonly [string, ReadonlyArray<{ kind: string; id: string; isSelf: boolean; token: string }>]
    > = [
      ["Fixture: <@!", [{ kind: "user", id: botUserId, isSelf: true, token: `<@!${botUserId}>` }]],
      ["Fixture: <@1564742987727118426> and", [
        { kind: "user", id: botUserId, isSelf: true, token: `<@${botUserId}>` },
        { kind: "role", id: role, isSelf: false, token: `<@&${role}>` },
        { kind: "channel", id: scratch, isSelf: false, token: `<#${scratch}>` }
      ]],
      ["Fixture: @everyone that", [{ kind: "broadcast", id: "everyone", isSelf: false, token: "@everyone" }]],
      // Posted without the ping, so Discord did not resolve it.
      ["Fixture: @everyone with parse", []]
    ]
    for (const [prefix, expected] of cases) {
      it(prefix, () => {
        const found = events("mentions").filter((dispatch) => String(dispatch.d.content).startsWith(prefix))
        assert.strictEqual(found.length, 1, prefix)
        assert.deepStrictEqual(mentionsOf(created(found[0])), expected)
      })
    }

    it("a token in code or escaped is not a mention", () => {
      const event = created({
        t: base.t,
        d: {
          ...base.d,
          content: "<@1> `<@2>` ``<@3>`` ```\n<@4>\n``` \\<@5> <@6>",
          mentions: ["1", "2", "3", "4", "5", "6"].map((id) => ({ id }))
        }
      })
      assert.deepStrictEqual(event.message.mentions.map((mention) => mention.id), ["1", "6"])
    })
  })

  it("reactions give the emoji, custom ones by name, and the message's author when added", () => {
    const found = events("reactions").map((dispatch) => normalize(dispatch)[0])
    assert.deepStrictEqual(
      found.slice(0, 4).map((event) =>
        event._tag === "ReactionAdded" ? [event.emoji, event.messageAuthorId] : [event._tag]
      ),
      [["\u{1F44D}", botUserId], ["\u{1F44D}\u{1F3FD}", botUserId], ["custom:effectchat", botUserId], [
        "ReactionRemoved"
      ]]
    )
    assert.strictEqual(Option.getOrThrow(DiscordChat.guildId(found[0])), guild)
  })
})

import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { assert, describe, it } from "@effect/vitest"
import type { ChatAdapter } from "effect/chat/ChatAdapter"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { ChatHandler, NotAccepted } from "effect/chat/ChatHandler"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import {
  adapter,
  answer,
  botUserId,
  discordLayer,
  errorResponse,
  events,
  type Fake,
  guild,
  makeFake,
  scratch,
  statusCodeError,
  step
} from "./utils.ts"

/** Runs `body` with the adapter over a fake answering from `handlers`. */
const withAdapter = (
  handlers: Parameters<typeof makeFake>[0],
  body: (discord: ChatAdapter, fake: Fake) => Effect.Effect<void, unknown, any>
) => {
  const fake = makeFake(handlers)
  return Effect.flatMap(adapter, (discord) => body(discord, fake)).pipe(
    Effect.provide(discordLayer(fake))
  ) as Effect.Effect<void, unknown>
}

const reason = <A>(effect: Effect.Effect<A, any>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => ({ op: error.op, tag: error.reason._tag, detail: error.reason.detail, retry: error.retry }))
  )

const channel = DiscordChat.thread(scratch)
const posted = step("posts", "channel-plain").response
const answers = { createMessage: () => Effect.succeed(posted) }

const history = step("history", "thread-history")
const threadId: string = step("history", "thread-start").response.id
const thread = DiscordChat.thread(threadId)
const threadChannel = step("history", "thread-get-channel").response
const forbidden = () => Effect.fail(errorResponse(403, { code: 50001, message: "Missing Access" }))

const noMentions = { parse: [], users: [], roles: [], replied_user: false }

describe("post", () => {
  it.effect("sends the Markdown as is, notifying nobody and suppressing embeds, with its files", () =>
    withAdapter(answers, (discord, fake) =>
      Effect.gen(function*() {
        const content = new TextEncoder().encode("hello from effect/chat\n")
        yield* discord.post(channel, {
          markdown: "hi <@1> @everyone **bold**",
          files: [{ name: "fixture.txt", contentType: "application/x-effect-fixture", content }]
        })
        assert.deepStrictEqual(fake.called("createMessage"), [[scratch, {
          content: "hi <@1> @everyone **bold**",
          allowed_mentions: noMentions,
          flags: 4,
          attachments: [{ id: "0", filename: "fixture.txt" }]
        }]])
        // The multipart part for attachment 0, sent with the message.
        const uploaded = yield* Effect.promise(() =>
          Promise.all(
            fake.called("withFiles").map(([files]) =>
              Promise.all(
                files.map(async (file: File) => [file.name, file.type, new Uint8Array(await file.arrayBuffer())])
              )
            )
          )
        )
        assert.deepStrictEqual(uploaded, [[["fixture.txt", "application/x-effect-fixture", content]]])
      })))

  it.effect("withPostOptions sets mentions, embeds and the reference, merging nested calls", () =>
    withAdapter(answers, (discord, fake) =>
      Effect.gen(function*() {
        yield* discord.post(channel, { markdown: "hi", replyTo: { messageId: "42" } }).pipe(
          DiscordChat.withPostOptions({ notify: { users: ["1"], roles: ["2"], everyone: true, repliedUser: true } }),
          DiscordChat.withPostOptions({ suppressEmbeds: false, failIfNotExists: false })
        )
        assert.deepStrictEqual(fake.called("createMessage")[0][1], {
          content: "hi",
          allowed_mentions: { parse: ["everyone"], users: ["1"], roles: ["2"], replied_user: true },
          flags: 0,
          message_reference: { message_id: "42", fail_if_not_exists: false }
        })
      })))

  it.effect("counts the 2,000 limit in code points, failing past it without a call", () =>
    withAdapter(answers, (discord, fake) =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* reason(discord.post(channel, { markdown: "a".repeat(2001) })), {
          op: "post",
          tag: "TooLarge",
          detail: "message_too_long",
          retry: "denied"
        })
        assert.strictEqual(fake.calls.length, 0)
        // 2,000 astral emoji are 4,000 UTF-16 units, and Discord took them.
        yield* discord.post(channel, { markdown: "\u{1F600}".repeat(2000) })
        assert.strictEqual(fake.called("createMessage").length, 1)
      })))

  it.effect("maps Discord's failures, sending a write once and a 5xx on it as uncertain", () =>
    Effect.forEach(
      [
        [answer(step("errors", "post-unknown-channel")), { tag: "NotFound", detail: "10003", retry: "denied" }],
        [answer(step("errors", "length-2001-ascii")), { tag: "TooLarge", detail: "50035", retry: "denied" }],
        [Effect.fail(statusCodeError(502)), { tag: "PlatformUnavailable", detail: "http_502", retry: "uncertain" }]
      ] as const,
      ([failure, expected]) =>
        withAdapter({ createMessage: () => failure }, (discord, fake) =>
          Effect.gen(function*() {
            assert.deepStrictEqual(yield* reason(discord.post(channel, { markdown: "x" })), { op: "post", ...expected })
            assert.strictEqual(fake.calls.length, 1)
          })),
      { discard: true }
    ))

  it.effect("a 5xx on a read is retried", () => {
    let attempts = 0
    return withAdapter({
      getMessage: () => attempts++ < 1 ? Effect.fail(statusCodeError(503)) : Effect.succeed(posted)
    }, (discord) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(discord.fetchMessage(channel, posted.id))
        yield* TestClock.adjust("1 second")
        assert.strictEqual((yield* Fiber.join(fiber)).id, posted.id)
      }))
  })

  it.effect("rejects an address that is not a Discord channel id", () =>
    withAdapter({}, (discord, fake) =>
      Effect.gen(function*() {
        const result = yield* reason(discord.post(DiscordChat.thread("../C123"), { markdown: "x" }))
        assert.strictEqual(result.tag, "InvalidRequest")
        assert.strictEqual(fake.calls.length, 0)
      })))

  it.effect("a post answer with an invalid timestamp fails instead of throwing", () =>
    withAdapter(
      { createMessage: () => Effect.succeed({ ...posted, timestamp: "not a date" }) },
      (discord) =>
        Effect.gen(function*() {
          const result = yield* reason(discord.post(channel, { markdown: "x" }))
          assert.deepStrictEqual([result.tag, result.detail], ["Unknown", "invalid_timestamp"])
        })
    ))

  it.effect("the adapter's own file count and size check is file_refused, without a call", () =>
    withAdapter({}, (discord, fake) =>
      Effect.gen(function*() {
        const file = { name: "fixture.txt", contentType: "text/plain", content: new Uint8Array(1) }
        const tooMany = Array.from({ length: discord.descriptor.limits.filesPerMessage + 1 }, () => file)
        const tooBig = [{ ...file, content: new Uint8Array(discord.descriptor.limits.uploadBytes + 1) }]
        for (const files of [tooMany, tooBig]) {
          assert.deepStrictEqual(yield* reason(discord.post(channel, { markdown: "x", files })), {
            op: "post",
            tag: "TooLarge",
            detail: "file_refused",
            retry: "denied"
          })
        }
        assert.strictEqual(fake.calls.length, 0)
      })))
})

describe("actions", () => {
  it.effect("go out as action rows: five buttons to a row and a select alone in its row", () =>
    withAdapter(answers, (discord, fake) =>
      Effect.gen(function*() {
        yield* discord.post(channel, {
          markdown: "x",
          actions: [
            { _tag: "Button", id: "go", label: "Go", style: "primary", value: "v" },
            { _tag: "Button", id: "stop", label: "Stop", style: "danger" },
            { _tag: "LinkButton", label: "Docs", url: "https://effect.website" },
            {
              _tag: "Select",
              id: "pick",
              options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
              selected: "b"
            },
            ...Array.from({ length: 6 }, (_, i) => ({ _tag: "Button" as const, id: "b" + i, label: "B" + i }))
          ]
        })
        assert.deepStrictEqual(fake.called("createMessage")[0][1].components, [
          {
            type: 1,
            components: [
              { type: 2, style: 1, label: "Go", custom_id: "go\u241Fv" },
              { type: 2, style: 4, label: "Stop", custom_id: "stop" },
              { type: 2, style: 5, label: "Docs", url: "https://effect.website" }
            ]
          },
          {
            type: 1,
            components: [{
              type: 3,
              custom_id: "pick",
              options: [{ label: "A", value: "a" }, { label: "B", value: "b", default: true }],
              min_values: 1,
              max_values: 1
            }]
          },
          ...[[0, 1, 2, 3, 4], [5]].map((row) => ({
            type: 1,
            components: row.map((i) => ({ type: 2, style: 2, label: "B" + i, custom_id: "b" + i }))
          }))
        ])
      })))

  it.effect("an id holding the join, which would forge a value, or a sixth row fails before the call", () =>
    withAdapter({}, (discord, fake) =>
      Effect.gen(function*() {
        const select = (id: string) => ({ _tag: "Select" as const, id, options: [{ label: "A", value: "a" }] })
        for (
          const [actions, expected] of [
            [[{ _tag: "Button", id: "a\u241Fb", label: "x" }], ["InvalidRequest", "invalid_action_id"]],
            // Six selects are six rows, one past Discord's five, though far under 25 actions.
            [["1", "2", "3", "4", "5", "6"].map(select), ["TooLarge", "too_many_actions"]]
          ] as const
        ) {
          const result = yield* reason(discord.post(channel, { markdown: "x", actions }))
          assert.deepStrictEqual([result.tag, result.detail], expected)
        }
        assert.strictEqual(fake.calls.length, 0)
      })))
})

it.effect("edit sends allowed_mentions and the SUPPRESS_EMBEDS flag", () =>
  withAdapter({ updateMessage: () => Effect.succeed(posted) }, (discord, fake) =>
    Effect.gen(function*() {
      yield* discord.edit(channel, "1", { markdown: "now with https://effect.website" })
      assert.deepStrictEqual(fake.called("updateMessage"), [[scratch, "1", {
        content: "now with https://effect.website",
        allowed_mentions: noMentions,
        flags: 4,
        components: []
      }]])
    })))

it.effect("edit fails TooLarge past 2,000 code points without a call", () =>
  withAdapter({}, (discord, fake) =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* reason(discord.edit(channel, "1", { markdown: "a".repeat(2001) })), {
        op: "edit",
        tag: "TooLarge",
        detail: "message_too_long",
        retry: "denied"
      })
      assert.strictEqual(fake.calls.length, 0)
    })))

describe("startThread", () => {
  it.effect("names the thread after the message, cut to 100 characters", () =>
    withAdapter({
      getMessage: () => Effect.succeed({ ...posted, content: "  first line\nsecond " + "x".repeat(200) }),
      createThreadFromMessage: () => Effect.succeed(step("history", "thread-start").response)
    }, (discord, fake) =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* discord.startThread(channel, threadId), thread)
        assert.strictEqual(
          fake.called("createThreadFromMessage")[0][2].name,
          ("first line second " + "x".repeat(200)).slice(0, 100)
        )
      })))

  it.effect("160004 gives the existing thread, whose id is the message's", () =>
    withAdapter(
      { createThreadFromMessage: () => answer(step("errors", "thread-start-again")) },
      (discord) =>
        Effect.gen(function*() {
          assert.deepStrictEqual(yield* discord.startThread(channel, threadId, { name: "x" }), thread)
        })
    ))

  it.effect("50024 on a message in a thread gives the thread, and elsewhere fails", () =>
    withAdapter({
      createThreadFromMessage: () => answer(step("errors", "forum-start-thread-again")),
      getChannel: (id: string) =>
        Effect.succeed(id === threadId ? threadChannel : step("channels", "get-channel-dm").response)
    }, (discord) =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* discord.startThread(thread, "1", { name: "x" }), thread)
        assert.strictEqual((yield* reason(discord.startThread(channel, "1", { name: "x" }))).detail, "50024")
      })))
})

describe("history and opener", () => {
  /** `listMessages` over `all`, newest first, as Discord answers with either bound. */
  const listFrom =
    (all: ReadonlyArray<any>) =>
    (_: string, { after, before, limit }: { after?: string; before?: string; limit: number }) =>
      Effect.succeed(
        all.filter((raw) =>
          (after === undefined || BigInt(raw.id) > BigInt(after)) &&
          (before === undefined || BigInt(raw.id) < BigInt(before))
        ).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, limit)
      )

  it.effect("history pages until a short page", () => {
    const many = Array.from(
      { length: 250 },
      (_, i) => ({ ...posted, id: String(1570607253965246584n + BigInt(i + 1)) })
    )
    return withAdapter({ listMessages: listFrom(many) }, (discord) =>
      Effect.gen(function*() {
        const found = yield* Stream.runCollect(discord.history(channel, { direction: "backward" }))
        assert.deepStrictEqual(Array.from(found, (message) => message.id), many.map((raw) => raw.id).reverse())
      }))
  })

  it.effect("history of a thread started from a message has its opener first, addressed to the parent", () =>
    withAdapter({ listMessages: listFrom(history.response) }, (discord) =>
      Effect.gen(function*() {
        const [opener, ...replies] = Array.from(
          yield* Stream.runCollect(discord.history(thread, { direction: "forward" }))
        )
        assert.deepStrictEqual([opener.id, opener.thread], [threadId, channel])
        assert.deepStrictEqual(
          replies.map((message) => message.id),
          history.response.filter((raw: any) => raw.type !== 21).map((raw: any) => raw.id).reverse()
        )
        for (const message of replies) assert.deepStrictEqual(message.thread, thread)
      })))

  it.effect("history of a thread whose opener was deleted starts at the first reply", () => {
    const deleted = step("history", "thread-deleted-history").response
    const deletedThread = DiscordChat.thread(step("history", "thread-deleted-start").response.id)
    return withAdapter({ listMessages: listFrom(deleted) }, (discord) =>
      Effect.gen(function*() {
        const found = yield* Stream.runCollect(discord.history(deletedThread, { direction: "forward" }))
        assert.deepStrictEqual(Array.from(found, (message) => message.id), [
          deleted.find((raw: any) => raw.type === 0).id
        ])
      }))
  })

  it.effect("opener reads the message in the parent for a thread started from a message", () =>
    withAdapter({
      getChannel: () => Effect.succeed(threadChannel),
      getMessage: (channelId: string) =>
        answer(step("history", channelId === threadId ? "thread-get-opener-by-thread-id" : "thread-get-opener"))
    }, (discord) =>
      Effect.gen(function*() {
        const opener = Option.getOrThrow(yield* discord.opener(thread))
        assert.strictEqual(opener.id, threadId)
        assert.deepStrictEqual(opener.thread, channel)
      })))

  it.effect("opener reads a forum post's starter in the post", () => {
    const starter = step("history", "forum-get-starter").response
    return withAdapter({
      getChannel: () => Effect.succeed(step("history", "forum-post").response),
      getMessage: () => Effect.succeed(starter)
    }, (discord) =>
      Effect.gen(function*() {
        const opener = Option.getOrThrow(yield* discord.opener(DiscordChat.thread(starter.id)))
        assert.deepStrictEqual([opener.id, opener.thread.id], [starter.id, starter.id])
      }))
  })

  it.effect("opener is None for a deleted opener and for a channel", () =>
    withAdapter({
      getChannel: (id: string) =>
        Effect.succeed(id === scratch ? step("channels", "get-channel-text").response : threadChannel),
      getMessage: () => answer(step("history", "thread-deleted-get-opener"))
    }, (discord) =>
      Effect.gen(function*() {
        assert.isTrue(Option.isNone(yield* discord.opener(thread)))
        assert.isTrue(Option.isNone(yield* discord.opener(channel)))
      })))

  it.effect("history skips an opener the bot can't read and starts at the first reply", () => {
    const { referenced_message: _, ...bare } = history.response.find((raw: any) => raw.type === 21)
    const reply = history.response.find((raw: any) => raw.type === 0)
    return withAdapter(
      { listMessages: () => Effect.succeed([reply, bare]), getMessage: forbidden },
      (discord) =>
        Effect.gen(function*() {
          const found = yield* Stream.runCollect(discord.history(thread, { direction: "forward" }))
          assert.deepStrictEqual(Array.from(found, (message) => message.id), [reply.id])
        })
    )
  })

  it.effect("opener is None when the bot can't read it", () =>
    withAdapter(
      { getChannel: () => Effect.succeed(threadChannel), getMessage: forbidden },
      (discord) =>
        Effect.gen(function*() {
          assert.isTrue(Option.isNone(yield* discord.opener(thread)))
        })
    ))
})

it.effect("download reads the message again for the URL and fails TooLarge past maxBytes", () => {
  const raw = step("posts", "attachment-fixed").response
  const attachment = { id: `${raw.id}/${raw.attachments[0].id}` }
  const content = new TextEncoder().encode("hello from effect/chat\n")
  return withAdapter(
    { getMessage: () => Effect.succeed(raw), download: () => Effect.succeed(content) },
    (discord, fake) =>
      Effect.gen(function*() {
        const bytes = yield* Stream.runCollect(discord.download(channel, attachment, { maxBytes: content.length }))
        assert.deepStrictEqual(Array.from(bytes), [content])
        assert.deepStrictEqual(fake.called("download")[0], [raw.attachments[0].url])
        const tooLarge = yield* reason(Stream.runCollect(discord.download(channel, attachment, { maxBytes: 5 })))
        assert.deepStrictEqual([tooLarge.tag, tooLarge.detail], ["TooLarge", "max_bytes"])
      })
  )
})

describe("getThread and getUser", () => {
  it.effect("getThread gives the kind, name and parent", () => {
    const dm = step("channels", "get-channel-dm").response
    return withAdapter(
      { getChannel: (id: string) => Effect.succeed(id === threadId ? threadChannel : dm) },
      (discord) =>
        Effect.gen(function*() {
          const info = yield* discord.getThread(thread)
          assert.deepStrictEqual([info.kind, info.name, info.parent], [
            "thread",
            "Fixture thread from a message",
            channel
          ])
          const direct = yield* discord.getThread(DiscordChat.thread(dm.id))
          assert.deepStrictEqual([direct.kind, direct.name], ["direct", undefined])
        })
    )
  })

  it.effect("getUser with in gives the guild nick, with the member as raw", () => {
    const member = { ...step("users", "get-member-bot").response, nick: "Janny" }
    return withAdapter({
      getChannel: () => Effect.succeed(step("channels", "get-channel-text").response),
      getGuildMember: () => Effect.succeed(member),
      getUser: () => answer(step("users", "get-user-bot"))
    }, (discord, fake) =>
      Effect.gen(function*() {
        const user = yield* discord.getUser(botUserId, { in: channel })
        assert.strictEqual(user.name, "Janny")
        assert.deepStrictEqual(user.raw, member)
        assert.deepStrictEqual(fake.called("getGuildMember"), [[guild, botUserId]])
        assert.strictEqual((yield* discord.getUser(botUserId)).name, "Janitor")
      }))
  })
})

describe("dispatch without channel_type", () => {
  const missing = events("channel-message-without-channel-type")[0]
  /** Dispatches `missing` through `DiscordChat.dispatch`, keeping what the handler saw. */
  const dispatcher = (seen: Array<ChatEvent.ChatEvent>) =>
    Effect.map(DiscordChat.DiscordChat, (discord) =>
      discord.dispatch(missing).pipe(
        Effect.provideService(
          ChatHandler,
          ChatHandler.of({ handle: (event) => Effect.sync(() => void seen.push(event)) })
        )
      ))

  it.effect("looks the channel up once", () =>
    withAdapter({ getChannel: () => Effect.succeed(threadChannel) }, (_, fake) =>
      Effect.gen(function*() {
        const seen: Array<ChatEvent.ChatEvent> = []
        const dispatch = yield* dispatcher(seen)
        yield* dispatch
        yield* dispatch
        assert.deepStrictEqual(seen.map((event) => event._tag === "MessageCreated" && event.kind), ["thread", "thread"])
        assert.deepStrictEqual(fake.called("getChannel"), [[scratch]])
      })))

  it.effect("fails NotAccepted when the lookup fails, and tries again next time", () => {
    let attempts = 0
    return withAdapter({
      getChannel: () =>
        attempts++ < 4
          ? Effect.fail(statusCodeError(500))
          : Effect.succeed(step("channels", "get-channel-text").response)
    }, () =>
      Effect.gen(function*() {
        const seen: Array<ChatEvent.ChatEvent> = []
        const dispatch = yield* dispatcher(seen)
        const fiber = yield* Effect.forkChild(Effect.flip(dispatch))
        yield* TestClock.adjust("10 seconds")
        assert.instanceOf(yield* Fiber.join(fiber), NotAccepted)
        assert.strictEqual(seen.length, 0)
        yield* dispatch
        assert.strictEqual(seen.length, 1)
      }))
  })

  it.effect("drops the event when the lookup is denied", () =>
    withAdapter({ getChannel: () => answer(step("errors", "get-channel-unknown")) }, () =>
      Effect.gen(function*() {
        const seen: Array<ChatEvent.ChatEvent> = []
        yield* Effect.flatten(dispatcher(seen))
        assert.strictEqual(seen.length, 0)
      })))
})

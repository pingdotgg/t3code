/**
 * The conformance suite against a real Slack workspace. Opt-in: it runs only
 * when these are set, so CI skips it.
 *
 * - `SLACK_LIVE_BOT_TOKEN`, `SLACK_LIVE_TEAM_ID` and `SLACK_LIVE_CHANNEL`: the
 *   bot and a channel it may write to.
 * - `SLACK_LIVE_USER_TOKEN`: a user token with `chat:write` and
 *   `channels:history`, for the rules that need another identity's
 *   message. Without it those rules fail at `userPosts`.
 * - `SLACK_LIVE_RECIPIENT`: a user id in the channel, the recipient of the
 *   mention stream when `SLACK_LIVE_USER_TOKEN` is not set.
 */
import * as SlackChat from "@effect/chat-slack/SlackChat"
import * as SlackWebApi from "@effect/chat-slack/SlackWebApi"
import { assert, describe, it } from "@effect/vitest"
import * as Chat from "effect/chat/Chat"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { conformance } from "effect/chat/ChatTest"
import type * as ChatThread from "effect/chat/ChatThread"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Semaphore from "effect/Semaphore"
import { adapter } from "./utils.ts"

const botToken = process.env.SLACK_LIVE_BOT_TOKEN
const userToken = process.env.SLACK_LIVE_USER_TOKEN
const teamId = process.env.SLACK_LIVE_TEAM_ID
const channel = process.env.SLACK_LIVE_CHANNEL
const recipientId = process.env.SLACK_LIVE_RECIPIENT

const field = (u: unknown, key: string): any =>
  typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Record<string, unknown>)[key] : undefined

describe.skipIf(botToken === undefined || teamId === undefined || channel === undefined)("live conformance", () => {
  const layer = SlackChat.layer({ botToken: Redacted.make(botToken!), teamId: teamId! }).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(FetchHttpClient.layer)
  )

  /** Posts as the user, reads the message back and normalises it as an inbound `message` event. */
  const userPosts = (thread: ChatThread.ChatThread, text: string): Effect.Effect<ChatEvent.ChatEvent> =>
    Effect.gen(function*() {
      if (userToken === undefined) return yield* Effect.die(new Error("SLACK_LIVE_USER_TOKEN is not set"))
      const user = yield* SlackWebApi.make({ botToken: Redacted.make(userToken) })
      const bot = yield* SlackWebApi.make({ botToken: Redacted.make(botToken!) })
      const parts = SlackChat.parts(thread)
      if (parts._tag === "None") return yield* Effect.die(new Error("not a Slack thread"))
      const { threadTs } = parts.value
      const posted = yield* user.call("chat.postMessage", {
        channel: parts.value.channel,
        text,
        ...(threadTs === undefined ? {} : { thread_ts: threadTs })
      }, { write: true })
      const ts = field(posted, "ts")
      const read = yield* user.call("conversations.replies", {
        channel: parts.value.channel,
        ts,
        latest: ts,
        oldest: ts,
        inclusive: true,
        limit: 1
      })
      const messages = field(read, "messages")
      const message = Array.isArray(messages) ? messages.find((m: any) => m.ts === ts) : undefined
      const auth = yield* bot.call("auth.test", {})
      const events = SlackChat.normalize({
        type: "event_callback",
        team_id: parts.value.team,
        event: { ...message, type: "message", channel: parts.value.channel, event_ts: ts }
      }, { teamId: parts.value.team, botUserId: field(auth, "user_id") ?? "" })
      if (events.length !== 1) return yield* Effect.die(new Error(`userPosts normalised to ${events.length} events`))
      return events[0]
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie)

  const rules = conformance({
    platform: "slack",
    thread: SlackChat.thread({ team: teamId ?? "", channel: channel ?? "" }),
    userPosts,
    parseMention: SlackChat.parseMention
  })

  // The rules share one channel and the project runs tests concurrently, so
  // one rule at a time.
  const one = Semaphore.makeUnsafe(1)
  for (const [name, rule] of Object.entries(rules)) {
    it.live(name, () => rule.pipe(Effect.provide(layer), Semaphore.withPermits(one, 1)), 600_000)
  }
})

/**
 * Slack's own parser, live: it decides a mention from the stored `text`,
 * which the offline tests can only predict. Each check reads back what Slack
 * stored. A post or edit stores no token unless `notify` allows it, and an
 * allowed user is stored as a token and a `user` element. A stream with an
 * allowed user split across two appends stores only that token, whole, and
 * once stopped keeps no U+200B. Everything posted is deleted.
 */
describe.skipIf(botToken === undefined || teamId === undefined || channel === undefined)("live mentions", () => {
  const layer = SlackChat.layer({ botToken: Redacted.make(botToken!), teamId: teamId! }).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(FetchHttpClient.layer)
  )
  const token = /<(?:@[UW][A-Z0-9]+|#[CG][A-Z0-9]+|!subteam\^[A-Z0-9]+|!(?:here|channel|everyone))(?:\|[^<>]*)?>/g
  const tokens = (text: string) => text.match(token) ?? []

  const setup = Effect.gen(function*() {
    const api = yield* SlackWebApi.make({ botToken: Redacted.make(botToken!) })
    const self: string = field(yield* api.call("auth.test", {}), "user_id")
    const slack = yield* adapter
    const stored = (ts: string) =>
      api.call("conversations.replies", { channel, ts, latest: ts, oldest: ts, inclusive: true, limit: 2 }).pipe(
        Effect.map((answer) => (field(answer, "messages") as Array<any>).find((message) => message.ts === ts))
      )
    /** Posts to `thread`, deleting the message when the scope closes. */
    const post = (thread: ChatThread.ChatThread, markdown: string) =>
      Effect.acquireRelease(
        slack.post(thread, { markdown }),
        ({ id }) => slack.delete(thread, id).pipe(Effect.ignore)
      )
    return { self, slack, stored, post }
  })

  it.live(
    "a post or edit stores no token unless allowed, and an allowed user as a token and element",
    () =>
      Effect.gen(function*() {
        const { post, self, slack, stored } = yield* setup
        const thread = SlackChat.thread({ team: teamId!, channel: channel! })
        const inputs = [
          `prose <@${self}> and <!channel>`,
          `entities &lt;@${self}> &#x3C;!here>`,
          `a fence\n\`\`\`\n<@${self}>\n\`\`\``
        ]
        for (const markdown of inputs) {
          const { id } = yield* post(thread, markdown)
          assert.deepStrictEqual(tokens((yield* stored(id)).text), [], `post ${markdown}`)
        }
        const edited = yield* post(thread, "to be edited")
        for (const markdown of inputs) {
          yield* slack.edit(thread, edited.id, { markdown })
          assert.deepStrictEqual(tokens((yield* stored(edited.id)).text), [], `edit ${markdown}`)
        }
        const allowed = SlackChat.withPostOptions({ notify: { users: [self] } })
        const elements = (blocks: unknown): Array<any> =>
          Array.isArray(blocks) ? blocks.flatMap((block) => [block, ...elements(field(block, "elements"))]) : []
        const hasUser = (message: any) =>
          elements(message.blocks).some((element) => element.type === "user" && element.user_id === self)
        const kept = yield* post(thread, `allowed <@${self}> not <!channel>`).pipe(allowed)
        const afterPost = yield* stored(kept.id)
        assert.deepStrictEqual(tokens(afterPost.text), [`<@${self}>`])
        assert.isTrue(hasUser(afterPost))
        yield* slack.edit(thread, kept.id, { markdown: `edited <@${self}> not <!here>` }).pipe(allowed)
        const afterEdit = yield* stored(kept.id)
        assert.deepStrictEqual(tokens(afterEdit.text), [`<@${self}>`])
        assert.isTrue(hasUser(afterEdit))
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(FetchHttpClient.layer)),
    600_000
  )

  it.live(
    "a stream split inside an allowed token stores it whole, suppresses the rest and leaves no U+200B",
    () =>
      Effect.gen(function*() {
        const { post, self, slack, stored } = yield* setup
        const recipient = userToken === undefined
          ? recipientId
          : field(
            yield* (yield* SlackWebApi.make({ botToken: Redacted.make(userToken) })).call("auth.test", {}),
            "user_id"
          )
        if (recipient === undefined) {
          return yield* Effect.die(new Error("set SLACK_LIVE_USER_TOKEN or SLACK_LIVE_RECIPIENT"))
        }
        const root = yield* post(SlackChat.thread({ team: teamId!, channel: channel! }), "streams")
        const thread = SlackChat.thread({ team: teamId!, channel: channel!, threadTs: root.id })
        const native = slack.nativeStream!
        const markdown = `hi <@${self}> and <!channel> &lt;@${self}>`
        const at = markdown.indexOf(self) + 2
        const allowed = SlackChat.withPostOptions({ notify: { users: [self] } })
        const { id } = yield* Effect.acquireRelease(
          native.start(thread, { markdown: "s ", recipient }).pipe(allowed),
          ({ id }) => slack.delete(thread, id).pipe(Effect.ignore)
        )
        const { held } = yield* native.append(thread, id, markdown.slice(0, at), undefined).pipe(allowed)
        yield* native.append(thread, id, markdown.slice(at - held, at) + markdown.slice(at), { flush: true }).pipe(
          allowed
        )
        // While open: the held text kept the allowed token whole, and nothing else is a token.
        assert.deepStrictEqual(tokens((yield* stored(id)).text), [`<@${self}>`])
        yield* native.stop(thread, id, { end: "done" }).pipe(allowed)
        const message = yield* stored(id)
        assert.deepStrictEqual(tokens(message.text), [`<@${self}>`])
        assert.notInclude(JSON.stringify([message.text, message.blocks]), "\u200B")
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(FetchHttpClient.layer)),
    600_000
  )
})

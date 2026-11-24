/**
 * The conformance suite against a real Discord guild. Opt-in: it runs only
 * when these are set, so CI skips it.
 *
 * - `DISCORD_LIVE_BOT_TOKEN` and `DISCORD_LIVE_CHANNEL`: the bot and a
 *   scratch text channel it may write to. Threads that `startThread` makes
 *   can't be deleted through the core ops, so they are left behind.
 * - `DISCORD_LIVE_SECOND_BOT_TOKEN`: a second bot in the guild, for the
 *   rules that need another identity's message. Without it,
 *   `DISCORD_LIVE_WEBHOOK_URL`, a webhook on the channel, stands in. Without
 *   either, those rules fail at `userPosts`.
 *
 * Of the buttons rules, only the outbound ones run here: `actions/posts`,
 * `actions/tooMany`, `actions/dataTooLarge`, the two
 * `descriptor/measure*Actions` rules and the `unsupported/buttons` and
 * `unsupported/selects` probes. The suite is given no `interactions` hook,
 * since nothing can click a button through the API, so no rule here clicks,
 * opens or submits a modal, or calls `DiscordChat.interaction` and its
 * callbacks. Those rules, and `post/refusedFile`, which needs `refuseFiles`,
 * run only over the stubbed REST in `conformance.test.ts`. Live evidence
 * for them needs a person clicking in a test guild.
 */
import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { describe, it } from "@effect/vitest"
import { DiscordConfig, DiscordREST, DiscordRESTMemoryLive } from "dfx"
import * as Chat from "effect/chat/Chat"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { conformance } from "effect/chat/ChatTest"
import type * as ChatThread from "effect/chat/ChatThread"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"

const botToken = process.env.DISCORD_LIVE_BOT_TOKEN
const secondToken = process.env.DISCORD_LIVE_SECOND_BOT_TOKEN
const webhookUrl = process.env.DISCORD_LIVE_WEBHOOK_URL
const channel = process.env.DISCORD_LIVE_CHANNEL

const restLayer = (token: string) =>
  DiscordRESTMemoryLive.pipe(
    Layer.provide(DiscordConfig.layer({ token: Redacted.make(token) })),
    Layer.provide(FetchHttpClient.layer)
  )

describe.skipIf(botToken === undefined || channel === undefined)("live conformance", () => {
  const bot = restLayer(botToken!)
  const layer = DiscordChat.layer.pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provideMerge(bot),
    Layer.provide(FetchHttpClient.layer)
  )

  /** Posts as the other identity, reads the message back as the bot and normalises it as a `MESSAGE_CREATE`. */
  const userPosts = (thread: ChatThread.ChatThread, text: string): Effect.Effect<ChatEvent.ChatEvent> =>
    Effect.gen(function*() {
      const posted: { readonly id: string } = secondToken !== undefined
        ? yield* Effect.flatMap(
          DiscordREST,
          (rest) => rest.createMessage(thread.id, { content: text, allowed_mentions: { parse: [] } })
        ).pipe(
          Effect.provide(restLayer(secondToken))
        )
        : webhookUrl !== undefined
        ? yield* Effect.tryPromise(async () => {
          const url = new URL(webhookUrl)
          url.searchParams.set("wait", "true")
          const channelInfo = await fetch(`https://discord.com/api/v10/channels/${thread.id}`, {
            headers: { authorization: `Bot ${botToken}` }
          }).then((response) => response.json()).then(Schema.decodeUnknownSync(Schema.Struct({ type: Schema.Number })))
          if (channelInfo.type === 11 || channelInfo.type === 10 || channelInfo.type === 12) {
            url.searchParams.set("thread_id", thread.id)
          }
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } })
          })
          if (!response.ok) throw new Error(`webhook answered ${response.status}`)
          return Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await response.json())
        })
        : yield* Effect.die(new Error("neither DISCORD_LIVE_SECOND_BOT_TOKEN nor DISCORD_LIVE_WEBHOOK_URL is set"))
      const rest = yield* DiscordREST
      const message = yield* rest.getMessage(thread.id, posted.id)
      const info = yield* rest.getChannel(thread.id)
      const discord = yield* DiscordChat.DiscordChat
      const result = DiscordChat.normalize({ t: "MESSAGE_CREATE", d: message }, {
        botUserId: yield* discord.botUserId,
        channelType: info.type
      })
      if (Result.isFailure(result) || result.success.length !== 1) {
        return yield* Effect.die(new Error("userPosts did not normalise to one event"))
      }
      return result.success[0]
    }).pipe(Effect.provide(layer), Effect.orDie)

  const rules = conformance({
    platform: "discord",
    thread: DiscordChat.thread(channel ?? ""),
    userPosts,
    parseMention: DiscordChat.parseMention
  })

  // The rules share one channel and the project runs tests concurrently, so
  // one rule at a time.
  const one = Semaphore.makeUnsafe(1)
  for (const [name, rule] of Object.entries(rules)) {
    it.live(name, () => rule.pipe(Effect.provide(layer), Semaphore.withPermits(one, 1)), 600_000)
  }
})

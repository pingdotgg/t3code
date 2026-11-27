/**
 * Events API deliveries captured from Slack (see fixtures/events). Each body
 * is the string Slack sent, so these run the webhook on real bytes.
 */
import { handleRequest, makeVerifier } from "@effect/chat-slack/internal/webhook"
import * as SlackChat from "@effect/chat-slack/SlackChat"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { dedupeKey } from "effect/chat/ChatEvent"
import { checkEvent, sameMessage } from "effect/chat/ChatTest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as fs from "node:fs"
import { appId, botUserId, channel, checkOptions, team } from "./utils.ts"

interface Delivery {
  readonly headers: Record<string, string>
  readonly body: string
}

const captured = (name: string): ReadonlyArray<Delivery> =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/events/${name}.json`, import.meta.url), "utf8")).deliveries

const cases = fs.readdirSync(new URL("./fixtures/events/", import.meta.url))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -5))

const context = { teamId: team, botUserId }

// Signed here, with a test secret: the capture never logs Slack's signature.
const secret = "captured-delivery-test-secret"

const sign = async (timestamp: string, body: string) => {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ])
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`)))
  return "v0=" + Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** One delivery through the webhook, with its captured content type. */
const deliver = Effect.fnUntraced(function*(delivery: Delivery) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = yield* Effect.promise(() => sign(timestamp, delivery.body))
  const web = new Request("http://localhost/slack/events", {
    method: "POST",
    body: delivery.body,
    headers: {
      "content-type": delivery.headers["content-type"],
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature
    }
  })
  const events: Array<ChatEvent.ChatEvent> = []
  const response = yield* handleRequest(HttpServerRequest.fromWeb(web), {
    verify: yield* makeVerifier(Redacted.make(secret)).pipe(Effect.provide(NodeCrypto.layerMac)),
    appId,
    teamId: team,
    botUserId: Effect.succeed(botUserId),
    handle: (event) => Effect.sync(() => void events.push(event)),
    deadline: Duration.seconds(2),
    maxBodySize: ByteSize.mebibytes(1)
  })
  assert.strictEqual(response.status, 200)
  return events
})

/** The events of every delivery of a case, in delivery order. */
const deliveries = (name: string) => Effect.forEach(captured(name), deliver)

const created = (events: ReadonlyArray<ChatEvent.ChatEvent>): ChatEvent.MessageCreated => {
  assert.strictEqual(events.length, 1)
  const event = events[0]
  assert(event._tag === "MessageCreated")
  return event
}

const mentions = (event: ChatEvent.MessageCreated) =>
  event.message.mentions.map(({ end, id, isSelf, start }) => ({
    id,
    isSelf,
    text: event.message.text.slice(start, end)
  }))

const partsOf = (thread: ChatEvent.MessageCreated["thread"]) => Option.getOrThrow(SlackChat.parts(thread))

const selfMention = (label = "") => [{ id: botUserId, isSelf: true, text: `<@${botUserId}${label}>` }]

describe("captured Events API deliveries", () => {
  it.live("every delivery passes the webhook and normalises as SlackChat.normalize does", () =>
    Effect.gen(function*() {
      for (const name of cases) {
        for (const delivery of captured(name)) {
          const events = yield* deliver(delivery)
          assert.deepStrictEqual(events, SlackChat.normalize(JSON.parse(delivery.body), context), name)
          for (const event of events) yield* checkEvent(event, checkOptions)
        }
      }
    }))

  it.live("a thread reply and a thread_broadcast belong to the root's thread", () =>
    Effect.gen(function*() {
      const root = created((yield* deliveries("thread-root"))[0]).message.id
      const reply = created((yield* deliveries("thread-reply"))[0])
      assert.deepStrictEqual(partsOf(reply.thread), { team, channel, threadTs: root })
      // Slack sent a message_changed for the broadcast before the broadcast itself.
      const [, broadcast] = yield* deliveries("thread-broadcast")
      assert.deepStrictEqual(partsOf(created(broadcast).thread), { team, channel, threadTs: root })
    }))

  it.live("a mention only in code, a Block Kit section or an attachment is not reported", () =>
    Effect.gen(function*() {
      for (const name of ["code-only-mention", "block-kit-mention", "attachment-mention"]) {
        const event = created((yield* deliveries(name))[0])
        assert.deepStrictEqual(event.message.mentions, [], name)
      }
    }))
})

type Body = { readonly event: Record<string, unknown> }

/** The `message` and `app_mention` deliveries of one message, matched by ts. */
const pairsOf = (name: string) => {
  const bodies = captured(name).map((delivery): Body => JSON.parse(delivery.body))
  return bodies.flatMap((mention) => {
    if (mention.event.type !== "app_mention" || mention.event.edited !== undefined) return []
    const message = bodies.filter((body) =>
      body.event.type === "message" && body.event.ts === mention.event.ts && body.event.hidden === undefined
    )
    assert.strictEqual(message.length, 1, name)
    return [[message[0], mention] as const]
  })
}

describe("captured deliveries for messages a person typed", () => {
  it.live("each message and app_mention pair normalises to the same event", () =>
    Effect.gen(function*() {
      const found: Array<string> = []
      for (const name of cases) {
        for (const [message, mention] of pairsOf(name)) {
          const fromMessage = created(SlackChat.normalize(message, context))
          const fromMention = created(SlackChat.normalize(mention, context))
          assert.strictEqual(dedupeKey(fromMessage), dedupeKey(fromMention), name)
          assert.isTrue(sameMessage(fromMessage.message, fromMention.message), name)
          const { raw: _a, ...left } = fromMessage.message
          const { raw: _b, ...right } = fromMention.message
          assert.deepStrictEqual(left, right, name)
          assert.deepStrictEqual(fromMessage.thread, fromMention.thread, name)
          assert.deepStrictEqual(
            mentions(fromMessage),
            selfMention(String(message.event.subtype) === "me_message" ? "|janitor2" : "")
          )
          found.push(name)
        }
      }
      assert.deepStrictEqual(found.sort(), [
        "human-edit-keeps-mention",
        "human-edit-removes-mention",
        "human-file-mention",
        "human-me-message",
        "human-mention",
        "human-thread-broadcast"
      ])
    }))

  it.live("an edit gives nothing, including the app_mention Slack sends when it adds a mention", () =>
    Effect.gen(function*() {
      const [original, changed, mention] = yield* deliveries("human-edit-adds-mention")
      assert.deepStrictEqual(created(original).message.mentions, [])
      assert.deepStrictEqual(changed, [])
      assert.deepStrictEqual(mention, [])
    }))

  it.live("reactions, with a skin tone and a custom emoji", () =>
    Effect.gen(function*() {
      const root = created((yield* deliveries("human-plain"))[0]).message.id
      const reactions = (yield* deliveries("human-reactions")).map((events) => {
        assert.strictEqual(events.length, 1)
        const event = events[0]
        assert(event._tag === "ReactionAdded" || event._tag === "ReactionRemoved")
        assert.strictEqual(event.messageId, root)
        return event
      })
      assert.deepStrictEqual(reactions.map((event) => [event._tag, event.emoji]), [
        ["ReactionAdded", "👍"],
        ["ReactionRemoved", "👍"],
        ["ReactionAdded", "👍🏼"],
        ["ReactionRemoved", "👍🏼"],
        ["ReactionAdded", "custom:effect"],
        ["ReactionRemoved", "custom:effect"]
      ])
      assert.strictEqual(new Set(reactions.map(dedupeKey)).size, 6)
    }))
})

describe("captured deliveries for stops", () => {
  it.live("only the first click on Stop names the open stream", () =>
    Effect.gen(function*() {
      const results = yield* deliveries("stop-stream")
      const root = created(results[0]).message.id
      const stream = created(results[2])
      assert.strictEqual(stream.message.text, "")
      const stops = results.flat().filter((event) => event._tag === "StopRequested")
      assert.deepStrictEqual(stops.map((event) => event.messageIds), [[stream.message.id], [], []])
      for (const stop of stops) assert.deepStrictEqual(partsOf(stop.thread), { team, channel, threadTs: root })
      // Each click is its own request.
      assert.strictEqual(new Set(stops.map(dedupeKey)).size, 3)
    }))
})

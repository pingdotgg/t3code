/**
 * The conformance suite against the default layer, over a stubbed Connector
 * that answers every write. Capabilities behind `unverified` are off, so
 * their rules check that the descriptor leaves them out and the ops refuse.
 */
import * as Adapter from "@effect/chat-teams/internal/adapter"
import * as Length from "@effect/chat-teams/internal/length"
import * as TeamsChat from "@effect/chat-teams/TeamsChat"
import { assert, describe, it } from "@effect/vitest"
import * as Chat from "effect/chat/Chat"
import { conformance } from "effect/chat/ChatTest"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

const appId = "00000000-0000-0000-0000-0000000000a1"
const tenantId = "00000000-0000-0000-0000-0000000000b2"
const conversationId = "19:conformance@thread.tacv2"
const thread = TeamsChat.thread(conversationId)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const makeConnector = (sent: Array<{ readonly url: URL; readonly body: string }> = []) => {
  let next = 1_700_000_000_000
  const posted = new Set<string>()
  return HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (request.body._tag === "Uint8Array") sent.push({ url, body: new TextDecoder().decode(request.body.body) })
      let response: Response
      if (url.host === "login.microsoftonline.com") {
        response = json({ access_token: "token", expires_in: 3600, token_type: "Bearer" })
      } else if (request.method === "POST") {
        const id = String(next++)
        posted.add(id)
        response = json({ id })
      } else if (request.method === "PUT" || request.method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").pop()!)
        const known = posted.has(id)
        if (request.method === "DELETE") posted.delete(id)
        response = known ? json({}) : json({ error: { code: "ActivityNotFound" } }, 404)
      } else if (url.pathname.includes("/members/")) {
        response = json({ id: "29:user", aadObjectId: "user", name: "User" })
      } else response = json({ members: [] })
      // As Fetch does: the response names the URL it came from, query included.
      Object.defineProperty(response, "url", { value: url.href })
      return HttpClientResponse.fromWeb(request, response)
    })
  )
}

const layer = (
  extra: Partial<Parameters<typeof TeamsChat.layer>[0]> = {},
  sent?: Array<{ readonly url: URL; readonly body: string }>
) =>
  TeamsChat.layer({ appId, tenantId, credentials: Redacted.make("secret"), ...extra }).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, makeConnector(sent))),
    Layer.provide(Layer.mergeAll(Digest.layerWebCrypto, Mac.layerWebCrypto)),
    Layer.provide(SecureRandom.layerWebCrypto)
  )

let sequence = 0

const options = {
  platform: "teams",
  thread,
  parseMention: TeamsChat.parseMention,
  userPosts: (at: typeof thread, text: string) =>
    Effect.sync(() => {
      const parts = TeamsChat.parts(at)
      const id = String(1_800_000_000_000 + sequence++)
      const events = TeamsChat.normalize({
        type: "message",
        id,
        timestamp: new Date().toISOString(),
        serviceUrl: "https://smba.trafficmanager.net/teams",
        channelId: "msteams",
        from: { id: "29:user", aadObjectId: "user", name: "User" },
        recipient: { id: `28:${appId}`, name: "Bot" },
        conversation: {
          id: parts._tag === "Some" ? parts.value.conversationId : conversationId,
          conversationType: "channel",
          tenantId
        },
        channelData: { tenant: { id: tenantId } },
        textFormat: "plain",
        text
      }, { appId })
      return events[0]!
    })
}

describe("conformance over the stubbed Connector", () => {
  const names = Object.keys(conformance(options))
  for (const name of names) {
    it.effect(name, () => conformance(options)[name].pipe(Effect.provide(layer())))
  }
})

describe("reads over the stubbed Connector", () => {
  it.effect("getThread sends its query and accepts the answer", () =>
    Effect.gen(function*() {
      const chat = yield* Chat.Chat
      const info = yield* chat.getThread(thread)
      assert.strictEqual(info.kind, "channel")
    }).pipe(Effect.provide(layer())))
})

describe("buttons over the stubbed Connector", () => {
  const buttons = layer({
    interactionKeys: [Redacted.make({ kty: "oct", kid: "k1", k: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" })],
    unverified: { buttons: true }
  })

  it.effect("counts the signed envelope against actionDataLength", () =>
    Effect.gen(function*() {
      const chat = yield* Chat.Chat
      // The raw id and value fit the cap; with the envelope they do not.
      const over = { _tag: "Button", id: "b", label: "B", value: "v".repeat(Adapter.actionDataLength - 1) } as const
      const error = yield* Effect.flip(chat.post(thread, { markdown: "x", actions: [over] }))
      assert.strictEqual(error.reason._tag, "TooLarge")
      const posted = yield* chat.post(thread, { markdown: "x", actions: [{ ...over, value: "v".repeat(400) }] })
      assert.isString(posted.id)
    }).pipe(Effect.provide(buttons)))
})

describe("command answers over the stubbed Connector", () => {
  it.effect("a private answer names its recipient by id alone, so it stays in the size bound", () => {
    const sent: Array<{ readonly url: URL; readonly body: string }> = []
    return Effect.gen(function*() {
      const service = yield* TeamsChat.TeamsChat
      const raw = {
        type: "message",
        id: "1",
        serviceUrl: "https://smba.trafficmanager.net/teams",
        from: { id: "29:user", aadObjectId: "user", name: "n".repeat(10_000) },
        conversation: { id: conversationId }
      }
      yield* Adapter.internals.get(service)!.answer(
        "respond",
        raw,
        { markdown: "a".repeat(Length.messageLength) },
        "ephemeral"
      )
      const answer = sent.find(({ url }) => url.searchParams.get("isTargetedActivity") === "true")!
      assert.deepStrictEqual(JSON.parse(answer.body).recipient, { id: "29:user" })
      assert.isAtMost(answer.body.length, Length.Edge)
    }).pipe(Effect.provide(layer({}, sent)))
  })
})

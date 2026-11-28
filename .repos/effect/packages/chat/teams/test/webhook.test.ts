/**
 * The messaging endpoint through `layerWebhook`, with tokens signed by a
 * key in a stubbed Bot Framework key set.
 */
import { modalMetadataLength } from "@effect/chat-teams/internal/adapter"
import * as Envelope from "@effect/chat-teams/internal/envelope"
import * as TeamsChat from "@effect/chat-teams/TeamsChat"
import { assert, describe, it } from "@effect/vitest"
import * as Chat from "effect/chat/Chat"
import type { ChatError } from "effect/chat/ChatError"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { ChatHandler } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import type * as ChatUi from "effect/chat/ChatUi"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Signature from "effect/crypto/Signature"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { Jwk, Jwt } from "effect/jose"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

const appId = "00000000-0000-0000-0000-0000000000a1"
const tenantId = "00000000-0000-0000-0000-0000000000b2"
const serviceUrl = "https://smba.trafficmanager.net/emea/"
const keysUrl = "https://login.botframework.com/v1/.well-known/keys"

const crypto = Layer.mergeAll(Digest.layerWebCrypto, Mac.layerWebCrypto, Signature.layerWebCrypto).pipe(
  Layer.provideMerge(SecureRandom.layerWebCrypto)
)

const Claims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  exp: Schema.Number,
  serviceurl: Schema.String
})

const activity = (overrides?: Record<string, unknown>) => ({
  type: "message",
  id: "1800000000001",
  timestamp: "2026-11-15T10:00:00.000Z",
  serviceUrl,
  channelId: "msteams",
  from: { id: "29:user", aadObjectId: "user", name: "User" },
  recipient: { id: `28:${appId}`, name: "Bot" },
  conversation: { id: "a:direct", conversationType: "personal", tenantId },
  channelData: { tenant: { id: tenantId } },
  text: "hello",
  ...overrides
})

const setup = Effect.fnUntraced(function*(options?: {
  readonly jwksUri?: string
  readonly teams?: Partial<Parameters<typeof TeamsChat.layer>[0]>
  readonly interactions?: ChatInteraction.Handler["Service"]
  readonly maxBodyBytes?: number
  /** Middleware that reads the whole body before the route does. */
  readonly readFirst?: boolean
}) {
  const pair = yield* Jwk.generateKeyPair({ algorithm: "RS256", kid: "k1" })
  const key = yield* Jwk.importPrivate(pair.privateKey, "RS256")
  const token = (claimed = serviceUrl) =>
    Effect.map(
      Jwt.sign(
        Claims,
        {
          iss: "https://api.botframework.com",
          aud: appId,
          exp: Math.floor(Date.now() / 1000) + 600,
          serviceurl: claimed
        },
        key,
        { kid: "k1" }
      ),
      Redacted.value
    )
  const fetched: Array<{ readonly url: string; readonly redirect: RequestRedirect | undefined }> = []
  const http = HttpClient.make((request, url, _signal, fiber) =>
    Effect.sync(() => {
      fetched.push({
        url: url.href,
        redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect
      })
      const body = url.href === keysUrl
        ? { keys: [{ ...pair.publicKey, endorsements: ["msteams"] }] }
        : url.pathname.endsWith("/openidconfiguration")
        ? { jwks_uri: options?.jwksUri ?? keysUrl }
        : {}
      return HttpClientResponse.fromWeb(request, Response.json(body))
    })
  )
  const events: Array<ChatEvent.ChatEvent> = []
  const readFirst = HttpRouter.middleware(
    (httpEffect) =>
      Effect.andThen(Effect.flatMap(HttpServerRequest.HttpServerRequest, (r) => r.arrayBuffer), httpEffect),
    { global: true }
  )
  const app = Layer.merge(
    TeamsChat.layerWebhook({ path: "/api/messages", maxBodyBytes: options?.maxBodyBytes }),
    options?.readFirst === true ? readFirst : Layer.empty
  ).pipe(
    Layer.provide(TeamsChat.layer({ appId, tenantId, credentials: Redacted.make("secret"), ...options?.teams })),
    Layer.provide(Chat.layer),
    Layer.provide(
      options?.interactions === undefined
        ? Layer.empty
        : Layer.succeed(ChatInteraction.Handler, options.interactions)
    ),
    Layer.provide(Layer.succeed(ChatHandler, { handle: (event) => Effect.sync(() => void events.push(event)) })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(crypto)
  )
  const { dispose, handler } = HttpRouter.toWebHandler(app, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
  const exchange = (body: unknown, authorization?: string) =>
    Effect.promise(() =>
      handler(
        new Request("http://localhost/api/messages", {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "content-type": "application/json",
            ...(authorization === undefined ? {} : { authorization })
          }
        })
      )
    )
  const send = (body: unknown, authorization?: string) =>
    Effect.map(exchange(body, authorization), (response) => response.status)
  return { events, exchange, fetched, send, token }
})

describe("layerWebhook", () => {
  it.effect("answers 413 past maxBodyBytes, also for a body middleware read first", () =>
    Effect.gen(function*() {
      for (const readFirst of [false, true]) {
        const { events, send, token } = yield* setup({ maxBodyBytes: 100, readFirst })
        assert.strictEqual(yield* send(activity(), `Bearer ${yield* token()}`), 413, `readFirst: ${readFirst}`)
        assert.strictEqual(events.length, 0)
      }
    }).pipe(Effect.provide(crypto)))

  it.effect("answers 403 without a valid token, and for a token bound to another serviceUrl", () =>
    Effect.gen(function*() {
      const { events, send, token } = yield* setup()
      assert.strictEqual(yield* send(activity()), 403)
      assert.strictEqual(yield* send(activity(), "Bearer not.a.token"), 403)
      const other = yield* token("https://smba.trafficmanager.net/amer/")
      assert.strictEqual(yield* send(activity(), `Bearer ${other}`), 403)
      const wrongTenant = activity({ conversation: { id: "a:direct", conversationType: "personal", tenantId: "x" } })
      assert.strictEqual(yield* send(wrongTenant, `Bearer ${yield* token()}`), 403)
      assert.strictEqual(events.length, 0)
    }).pipe(Effect.provide(crypto)))

  it.effect("hands a verified message to the ChatHandler, and drops a targeted one", () =>
    Effect.gen(function*() {
      const { events, send, token } = yield* setup()
      const bearer = `Bearer ${yield* token()}`
      assert.strictEqual(yield* send(activity(), bearer), 200)
      assert.strictEqual(
        yield* send(activity({ id: "1800000000002", recipient: { id: `28:${appId}`, isTargeted: true } }), bearer),
        200
      )
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0]._tag, "MessageCreated")
    }).pipe(Effect.provide(crypto)))

  it.effect("fetches the metadata and the key set with redirects off", () =>
    Effect.gen(function*() {
      const { fetched, send, token } = yield* setup()
      assert.strictEqual(yield* send(activity(), `Bearer ${yield* token()}`), 200)
      const discovery = fetched.filter((request) => request.url.startsWith("https://login.botframework.com/"))
      assert.deepStrictEqual(discovery.map((request) => request.url), [
        "https://login.botframework.com/v1/.well-known/openidconfiguration",
        keysUrl
      ])
      assert.isTrue(discovery.every((request) => request.redirect === "manual"))
    }).pipe(Effect.provide(crypto)))

  it.effect("answers 503 for metadata whose jwks_uri is not a URL", () =>
    Effect.gen(function*() {
      const { events, send, token } = yield* setup({ jwksUri: "not a URL" })
      assert.strictEqual(yield* send(activity(), `Bearer ${yield* token()}`), 503)
      assert.strictEqual(events.length, 0)
    }).pipe(Effect.provide(crypto)))
})

describe("dialogs through layerWebhook", () => {
  const interactionKey = Redacted.make(
    { kty: "oct", kid: "k1", k: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc" } as const
  )
  const channel = "19:abc@thread.tacv2"
  // A click on a card posted as a channel post: the root of its own reply chain.
  const clicked = `${channel};messageid=123`
  const modal: ChatUi.Modal = {
    _tag: "Modal",
    id: "deploy",
    title: "Deploy",
    elements: [
      { _tag: "TextInput", id: "constructor", label: "Name", initial: "first" },
      { _tag: "TextInput", id: "note", label: "Note", initial: "draft" }
    ]
  }

  const open = Effect.fnUntraced(function*(opens: ChatUi.Modal) {
    const submits: Array<ChatInteraction.ModalSubmitted> = []
    const refusals: Array<ChatError> = []
    const { exchange, token } = yield* setup({
      teams: { interactionKeys: [interactionKey], modalButtons: ["open"], unverified: { buttons: true, modals: true } },
      interactions: {
        click: () => Effect.succeed(ChatInteraction.OpenModal.make({ modal: opens })),
        submit: (event) =>
          Effect.sync(() => {
            submits.push(event)
            return ChatInteraction.errors({ note: "Too short" })
          }),
        command: () => Effect.succeed(ChatInteraction.ack),
        refused: (_, error) => Effect.sync(() => void refusals.push(error))
      }
    })
    const bearer = `Bearer ${yield* token()}`
    const invoke = (overrides: Record<string, unknown>) =>
      exchange(
        activity({
          type: "invoke",
          conversation: { id: clicked, conversationType: "channel", tenantId },
          ...overrides
        }),
        bearer
      ).pipe(Effect.flatMap((response) => Effect.promise((): Promise<any> => response.json())))
    const envelope = yield* Envelope.make({ appId, tenantId, keys: [interactionKey] })
    const button = yield* envelope.signButton(channel, { id: "open" })
    const opened = yield* invoke({ name: "task/fetch", replyToId: "123", value: { data: { effect: button } } })
    const dialog: string | undefined = opened?.task?.value?.card?.content?.actions?.[0]?.data?.effect
    const submit = (values: Record<string, string>) =>
      invoke({ name: "task/submit", value: { data: { effect: dialog ?? null, ...values } } })
    return { dialog, refusals, submit, submits }
  })

  it.effect("opens a dialog only when its whole signed token fits modalMetadataLength", () =>
    Effect.gen(function*() {
      // Short id and no metadata: the definition alone makes the token long.
      const withText = (length: number): ChatUi.Modal => ({
        ...modal,
        elements: [{ _tag: "Text", text: "x".repeat(length) }, ...modal.elements]
      })
      const big = yield* open(withText(3_500))
      assert.isUndefined(big.dialog)
      assert.strictEqual(big.refusals[0]?.reason._tag, "TooLarge")

      const small = yield* open(withText(1_000))
      assert.isString(small.dialog)
      assert.isAtMost(small.dialog!.length, modalMetadataLength)
      assert.strictEqual(small.refusals.length, 0)
    }).pipe(Effect.provide(crypto)))

  it.effect("a submit keeps the thread and message of the click", () =>
    Effect.gen(function*() {
      const { submit, submits } = yield* open(modal)
      yield* submit({ constructor: "a", note: "b" })
      assert.strictEqual(submits.length, 1)
      assert.deepStrictEqual(submits[0].thread, TeamsChat.thread(channel))
      assert.strictEqual(submits[0].messageId, "123")
    }).pipe(Effect.provide(crypto)))

  it.effect("an error reply keeps what the user entered, and reads no inherited key", () =>
    Effect.gen(function*() {
      const { submit } = yield* open(modal)
      const reply = yield* submit({ constructor: "edited", note: "b" })
      const body: ReadonlyArray<any> = reply.task.value.card.content.body
      const inputs = body.filter((element) => element.type === "Input.Text")
      assert.deepStrictEqual(inputs.map((input) => input.value), ["edited", "b"])
      const texts = body.filter((element) => element.type === "TextBlock").map((element) => element.text)
      assert.deepStrictEqual(texts, ["Too short"])
    }).pipe(Effect.provide(crypto)))
})

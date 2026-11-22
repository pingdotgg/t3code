import * as WhatsAppChat from "@effect/chat-whatsapp/WhatsAppChat"
import * as Chat from "effect/chat/Chat"
import type { ChatEvent } from "effect/chat/ChatEvent"
import { ChatHandler } from "effect/chat/ChatHandler"
import { type Interactions, NoSuchElement } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"

export const phoneNumberId = "106540352242922"
export const business = "15550783881"
export const bsuid = "US.13491208655302741918"
export const phone = "16505551234"
export const thread = WhatsAppChat.thread({ phoneNumberId, user: bsuid })

export interface FakeCall {
  readonly method: string
  readonly path: string
  readonly body: any
}

/** An answer with a status, or a JSON body for a 200. */
export type Answer = { readonly status: number; readonly body?: unknown } | Record<string, unknown>

/** A Graph error answer, as Meta sends it. */
export const graphError = (code: number, status = 400, subcode?: number): Answer => ({
  status,
  body: { error: { message: "refused", type: "OAuthException", code, error_subcode: subcode, fbtrace_id: "A" } }
})

/**
 * A Graph API that keeps the messages the adapter sends by id, and the media
 * it uploads. `next` holds one-shot answers for a path.
 */
export const makeGraph = () => {
  const calls: Array<FakeCall> = []
  const messages = new Map<string, any>()
  const media = new Map<string, { readonly type: string; readonly bytes: Uint8Array }>()
  const next = new Map<string, Answer>()
  let count = 0

  const answer = async (request: HttpClientRequest.HttpClientRequest, url: URL): Promise<Answer | Uint8Array> => {
    const path = url.host === "lookaside.test" ? url.pathname : url.pathname.replace(/^\/v[\d.]+\//, "")
    const raw = request.body
    let body: any
    if (raw._tag === "FormData") body = Object.fromEntries(raw.formData.entries())
    else if (raw._tag === "Uint8Array") body = JSON.parse(new TextDecoder().decode(raw.body))
    calls.push({ method: request.method, path, body })
    const scripted = next.get(path)
    if (scripted !== undefined) {
      next.delete(path)
      return scripted
    }
    if (url.host === "lookaside.test") return media.get(path.slice(1))!.bytes
    if (path === `${phoneNumberId}/media`) {
      const id = "media-" + ++count
      media.set(id, { type: body.type, bytes: new Uint8Array(await (body.file as Blob).arrayBuffer()) })
      return { id }
    }
    if (path === `${phoneNumberId}/messages`) {
      if (body.status === "read") return { success: true }
      const id = "wamid.out" + ++count
      messages.set(id, body)
      const to = body.to ?? body.recipient
      return {
        messaging_product: "whatsapp",
        contacts: [{ input: to, ...(body.to === undefined ? { user_id: to } : { wa_id: to }) }],
        messages: [{ id }]
      }
    }
    const stored = media.get(path)
    if (stored === undefined) return graphError(100, 400, 33)
    return { url: `https://lookaside.test/${path}`, mime_type: stored.type, file_size: stored.bytes.length, id: path }
  }

  const client = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const result = await answer(request, url)
      const web = result instanceof Uint8Array
        ? new Response(result as Uint8Array<ArrayBuffer>, { status: 200 })
        : "status" in result && typeof result.status === "number"
        ? new Response(JSON.stringify(result.body ?? {}), { status: result.status })
        : new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })
      return HttpClientResponse.fromWeb(request, web)
    })
  )

  return {
    calls,
    messages,
    next,
    sent: () => calls.filter((call) => call.path === `${phoneNumberId}/messages`).map((call) => call.body),
    layer: Layer.succeed(HttpClient.HttpClient, client)
  }
}

/** `Chat`, `Registry` and the WhatsApp adapter on a fake Graph API. */
export const whatsappLayer = (
  graph: ReturnType<typeof makeGraph>,
  options?: { readonly messagingAccountId?: string }
) =>
  WhatsAppChat.layer({ accessToken: Redacted.make("EAAG-test"), phoneNumberId, ...options }).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(graph.layer)
  )

let inboundCount = 0

/** A webhook delivery with one message from the test user. */
export const inbound = (message: Record<string, unknown>, options?: { readonly phoneNumberId?: string }) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "102290129340398",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: business, phone_number_id: options?.phoneNumberId ?? phoneNumberId },
        contacts: [{ profile: { name: "Sheena Nelson" }, user_id: bsuid, wa_id: phone }],
        messages: [{
          from: phone,
          from_user_id: bsuid,
          id: "wamid.in" + ++inboundCount,
          timestamp: "1794600000",
          ...message
        }]
      }
    }]
  }]
})

/** A webhook delivery with statuses. */
export const statuses = (...items: ReadonlyArray<Record<string, unknown>>) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "102290129340398",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: business, phone_number_id: phoneNumberId },
        statuses: items
      }
    }]
  }]
})

const join = "\u241F"

/** The user's text, as `ChatTest.conformance` wants it. */
export const userPosts = (_thread: unknown, text: string): Effect.Effect<ChatEvent> =>
  Effect.sync(() =>
    WhatsAppChat.normalize(inbound({ type: "text", text: { body: text } }), { phoneNumberId })[0] as ChatEvent
  )

/**
 * The conformance hook: builds the `button_reply` or `list_reply` of a
 * reply button or list row the adapter sent, and delivers it through
 * `WhatsAppChat.receive`.
 */
export const makeInteractions = (graph: ReturnType<typeof makeGraph>) => {
  let service: WhatsAppChat.WhatsAppChat["Service"] | undefined
  const bind = Effect.tap(WhatsAppChat.WhatsAppChat, (whatsapp) =>
    Effect.sync(() => {
      service = whatsapp
    }))
  const interactions: Interactions = {
    click: Effect.fnUntraced(function*(messageId, id, options) {
      const interactive = graph.messages.get(messageId)?.interactive
      const choices: Array<{ readonly id: string; readonly title: string }> = interactive?.type === "button"
        ? interactive.action.buttons.map((button: any) => button.reply)
        : interactive?.type === "list"
        ? interactive.action.sections.flatMap((section: any) => section.rows)
        : []
      const choice = choices.find((choice) => {
        if (choice.id.startsWith("b")) return choice.id.slice(1).split(join)[0] === id
        const [select, ...value] = choice.id.slice(1).split(join)
        return select === id && (options?.option === undefined || value.join(join) === options.option)
      })
      if (choice === undefined) return yield* Effect.fail(new NoSuchElement({ messageId, id }))
      const kind = interactive.type === "button" ? "button_reply" : "list_reply"
      yield* service!.receive(inbound({
        type: "interactive",
        context: { from: business, id: messageId },
        interactive: { type: kind, [kind]: choice }
      })).pipe(
        Effect.provideService(ChatHandler, ChatHandler.of({ handle: () => Effect.void })),
        Effect.orDie
      )
    }),
    submit: () => Effect.void
  }
  return { bind, interactions }
}

import * as TelegramChat from "@effect/chat-telegram/TelegramChat"
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

/** A marker token: no error, span or log may contain it. */
export const token = "123456789:AAH-marker_TOKEN_must_not_leak"
export const botId = "123456789"
const username = "effect_bot"
export const chatId = -1001234567890
export const thread = TelegramChat.thread(chatId)
const user = { id: 4242, is_bot: false, first_name: "Ada" }

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } })

/** A Bot API error answer, as Telegram sends it. */
export const apiError = (code: number, description: string, parameters?: unknown) => ({
  status: code,
  body: { ok: false, error_code: code, description, ...(parameters === undefined ? {} : { parameters }) }
})

type Answer = { readonly status: number; readonly body: unknown }

const readBody = (request: HttpClientRequest.HttpClientRequest): any => {
  const raw = request.body
  if (raw._tag === "Uint8Array") return JSON.parse(new TextDecoder().decode(raw.body))
  if (raw._tag !== "FormData") return {}
  const body: Record<string, unknown> = {}
  for (const [key, value] of raw.formData.entries()) {
    if (typeof value !== "string") body[key] = value
    else {
      try {
        body[key] = JSON.parse(value)
      } catch {
        body[key] = value
      }
    }
  }
  return body
}

/**
 * A Bot API that keeps the messages the adapter sends by id. `next` holds
 * one-shot answers for a method.
 */
export const makeApi = () => {
  const calls: Array<{ readonly method: string; readonly body: any }> = []
  const messages = new Map<number, any>()
  const next = new Map<string, Answer>()
  /** The batches `getUpdates` gives, in order. Once they run out it never answers. */
  const updates: Array<ReadonlyArray<unknown>> = []
  let count = 100

  const answer = (method: string, body: any): Answer => {
    switch (method) {
      case "getMe":
        return ok({ id: Number(botId), is_bot: true, first_name: "Effect", username })
      case "sendRichMessage": {
        const id = ++count
        messages.set(id, body)
        return ok({
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "supergroup", title: "Effect" },
          ...(body.reply_markup === undefined ? {} : { reply_markup: body.reply_markup })
        })
      }
      case "editMessageText":
        if (!messages.has(body.message_id)) return apiError(400, "Bad Request: message to edit not found")
        messages.set(body.message_id, { ...messages.get(body.message_id), ...body })
        return ok(true)
      case "deleteMessage":
        if (!messages.delete(body.message_id)) return apiError(400, "Bad Request: message to delete not found")
        return ok(true)
      case "getChat":
        return ok({ id: body.chat_id, type: "supergroup", title: "Effect" })
      case "getChatMember":
        return ok({ status: "member", user: { ...user, id: body.user_id } })
      case "getFile":
        return ok({ file_id: body.file_id, file_unique_id: "u", file_size: 5, file_path: "documents/file_1.txt" })
      case "answerCallbackQuery":
        return ok(true)
      default:
        return apiError(404, "Not Found")
    }
  }

  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const file = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname)
      if (file !== null) {
        calls.push({ method: "file", body: file[1] })
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new TextEncoder().encode("hello"))))
      }
      const method = url.pathname.split("/").pop()!
      const body = readBody(request)
      calls.push({ method, body })
      let scripted = next.get(method)
      if (scripted !== undefined) next.delete(method)
      if (scripted === undefined && method === "getUpdates") {
        const batch = updates.shift()
        if (batch === undefined) return Effect.never
        scripted = ok(batch)
      }
      const { body: json, status } = scripted ?? answer(method, body)
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })
      ))
    })
  )

  return {
    calls,
    messages,
    next,
    updates,
    sent: (method: string) => calls.filter((call) => call.method === method).map((call) => call.body),
    layer: Layer.succeed(HttpClient.HttpClient, client)
  }
}

export type FakeApi = ReturnType<typeof makeApi>

/** `Chat`, `Registry` and the adapter on a fake Bot API, with every capability on. */
export const telegramLayer = (api: FakeApi) =>
  TelegramChat.layer({ token: Redacted.make(token), unverified: { files: true, buttons: true, commands: true } }).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(api.layer)
  )

let updateId = 900_000

/** An update with one message from `from` in the test supergroup. */
export const messageUpdate = (message: Record<string, unknown>, from: object = user) => {
  const id = ++updateId
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "supergroup", title: "Effect" },
      from,
      ...message
    }
  }
}

/** A command message, with its `bot_command` entity. */
export const commandUpdate = (name: string, text = "", extra?: Record<string, unknown>) =>
  messageUpdate({
    text: text === "" ? `/${name}` : `/${name} ${text}`,
    entities: [{ type: "bot_command", offset: 0, length: name.length + 1 }],
    ...extra
  })

/** A click on `data` from `user`, on the message as Telegram keeps it. */
export const callbackUpdate = (message: Record<string, unknown>, data: string) => ({
  update_id: ++updateId,
  callback_query: { id: "cq" + updateId, from: user, chat_instance: "1", data, message }
})

export const context = { botId, botUsername: username }

/** The user's text, as `ChatTest.conformance` wants it. */
export const userPosts = (_thread: unknown, text: string): Effect.Effect<ChatEvent> =>
  Effect.sync(() => TelegramChat.normalize(messageUpdate({ text }), context)[0])

const noHandler = Layer.succeed(ChatHandler, ChatHandler.of({ handle: () => Effect.void }))

/** The conformance hook: clicks and commands go through `TelegramChat.receive`. */
export const makeInteractions = (api: FakeApi) => {
  let service: TelegramChat.TelegramChat["Service"] | undefined
  const bind = Effect.tap(TelegramChat.TelegramChat, (telegram) =>
    Effect.sync(() => {
      service = telegram
    }))
  const receive = (update: unknown) => service!.receive(update).pipe(Effect.provide(noHandler), Effect.asVoid)
  const interactions: Interactions = {
    click: Effect.fnUntraced(function*(messageId, id) {
      const sent = api.messages.get(Number(messageId))
      const buttons: Array<{ readonly callback_data?: string }> = sent?.reply_markup?.inline_keyboard?.flat() ?? []
      const button = buttons.find((b) => b.callback_data?.split("\u001f")[0] === id)
      if (button?.callback_data === undefined) return yield* Effect.fail(new NoSuchElement({ messageId, id }))
      yield* receive(callbackUpdate({
        message_id: Number(messageId),
        date: Math.floor(Date.now() / 1000),
        chat: { id: sent.chat_id, type: "supergroup", title: "Effect" },
        from: { id: Number(botId), is_bot: true, first_name: "Effect" },
        text: "x",
        reply_markup: sent.reply_markup
      }, button.callback_data))
    }),
    submit: () => Effect.void,
    command: (_thread, id, options) => receive(commandUpdate(id, options?.text ?? ""))
  }
  return { bind, interactions }
}

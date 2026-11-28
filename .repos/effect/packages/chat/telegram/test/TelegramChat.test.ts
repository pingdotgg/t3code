/**
 * The adapter's own guarantees, over a fake Bot API, that the conformance
 * suite does not see: credentials stay out of errors, spans and logs, the
 * webhook's answers, private answers, clicks, excluded contexts, delivery
 * keys, polling and deadlines.
 */
import * as TelegramChat from "@effect/chat-telegram/TelegramChat"
import { assert, describe, it } from "@effect/vitest"
import * as Chat from "effect/chat/Chat"
import type { ChatError } from "effect/chat/ChatError"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { ChatHandler, NotAccepted } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Headers from "effect/http/Headers"
import * as HttpMiddleware from "effect/http/HttpMiddleware"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as Tracer from "effect/Tracer"
import {
  apiError,
  botId,
  callbackUpdate,
  chatId,
  commandUpdate,
  context,
  type FakeApi,
  makeApi,
  messageUpdate,
  telegramLayer,
  thread,
  token
} from "./utils.ts"

const secret = "s".repeat(32)

/** What reached the consumer, by kind. */
const makeRecorder = (options?: {
  readonly command?: () => Effect.Effect<ChatInteraction.CommandReply>
  readonly click?: Effect.Effect<void>
  readonly handle?: Effect.Effect<void, NotAccepted>
}) => {
  const events: Array<ChatEvent.ChatEvent> = []
  const clicks: Array<ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged> = []
  const commands: Array<ChatInteraction.CommandInvoked> = []
  const refused: Array<ChatError> = []
  const unhandled: Array<Schema.Json> = []
  const handler = ChatHandler.of({
    handle: (event) => options?.handle ?? Effect.sync(() => void events.push(event))
  })
  const interactions = ChatInteraction.Handler.of({
    click: (event) => Effect.as(options?.click ?? Effect.sync(() => void clicks.push(event)), ChatInteraction.ack),
    submit: () => Effect.succeed(ChatInteraction.close),
    command: (event) =>
      Effect.andThen(
        Effect.sync(() => void commands.push(event)),
        options?.command?.() ?? Effect.succeed(ChatInteraction.ack)
      ),
    refused: (_, error) => Effect.sync(() => void refused.push(error))
  })
  const onUnhandled = (update: Schema.Json) => Effect.sync(() => void unhandled.push(update))
  return { events, clicks, commands, refused, unhandled, handler, interactions, onUnhandled }
}

type Recorder = ReturnType<typeof makeRecorder>

/** Runs updates through `TelegramChat.receive`, as the transports do. */
const receive = (api: FakeApi, recorder: Recorder, ...updates: ReadonlyArray<unknown>) =>
  Effect.gen(function*() {
    const telegram = yield* TelegramChat.TelegramChat
    const outcomes: Array<TelegramChat.Outcome> = []
    for (const update of updates) {
      outcomes.push(yield* telegram.receive(update, { onUnhandled: recorder.onUnhandled }))
    }
    return outcomes
  }).pipe(
    Effect.provideService(ChatHandler, recorder.handler),
    Effect.provideService(ChatInteraction.Handler, recorder.interactions),
    Effect.provide(telegramLayer(api))
  )

const spanTracer = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return { spans, tracer }
}

/** What makes a message private: id 0, with its own private id. */
const ephemeral = { message_id: 0, ephemeral_message_id: 7 }

/** A click on `data`, on a message whose keyboard has one `approve` button. */
const click = (data: string, date = 1_800_000_000) =>
  callbackUpdate({
    message_id: 5,
    date,
    chat: { id: chatId, type: "supergroup" },
    text: "x",
    reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "approve" }]] }
  }, data)

/** Yields until `done` holds. */
const until = Effect.fnUntraced(function*(done: () => boolean) {
  while (!done()) yield* Effect.yieldNow
})

it.effect("keeps the token out of errors, spans and logs", () =>
  Effect.gen(function*() {
    const api = makeApi()
    const { spans, tracer } = spanTracer()
    const logs: Array<string> = []
    const logger = Logger.formatJson.pipe(Logger.map((line): void => void logs.push(line)))
    api.next.set("sendRichMessage", apiError(401, "Unauthorized"))
    const exit = yield* Effect.flatMap(Chat.Chat, (chat) => chat.post(thread, { markdown: "hi" })).pipe(
      Effect.tapCause((cause) => Effect.logError("post failed", cause)),
      Effect.exit,
      Effect.provide(telegramLayer(api)),
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(Tracer.Tracer, tracer)
    )
    assert.isTrue(Exit.isFailure(exit))
    assert.isTrue(spans.some((span) => span.name === "TelegramBotApi.sendRichMessage"))
    const seen = [
      JSON.stringify(exit),
      ...logs,
      ...spans.map((span) => JSON.stringify([span.name, [...span.attributes], span.events]))
    ].join("\n")
    assert.isFalse(seen.includes(token.split(":")[1]))
  }))

it.effect("maps the rich message errors captured in live check 10", () =>
  Effect.gen(function*() {
    const captured: ReadonlyArray<readonly [string, string, string]> = [
      ["RICH_MESSAGE_TOO_LARGE", "TooLarge", "message_too_large"],
      ["RICH_MESSAGE_DEPTH_INVALID", "InvalidRequest", "too_deep"]
    ]
    for (const [description, tag, detail] of captured) {
      const api = makeApi()
      api.next.set("sendRichMessage", apiError(400, `Bad Request: ${description}`))
      const error = yield* Effect.flatMap(Chat.Chat, (chat) => chat.post(thread, { markdown: "hi" })).pipe(
        Effect.flip,
        Effect.provide(telegramLayer(api))
      )
      assert.deepStrictEqual([error.reason._tag, (error.reason as { readonly detail?: string }).detail], [tag, detail])
    }
  }))

describe("layerWebhook", () => {
  const webhook = Effect.fnUntraced(function*(
    recorder: Recorder,
    server: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.empty
  ) {
    const app = TelegramChat.layerWebhook({ path: "/telegram", secretToken: Redacted.make(secret), maxBodyBytes: 4096 })
      .pipe(
        Layer.provide(telegramLayer(makeApi())),
        Layer.provide(Layer.succeed(ChatHandler, recorder.handler)),
        Layer.provideMerge(server)
      )
    const { dispose, handler } = HttpRouter.toWebHandler(app, { disableLogger: true })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
    return (body: string, header?: string) =>
      Effect.promise(() =>
        handler(
          new Request("http://localhost/telegram", {
            method: "POST",
            body,
            headers: header === undefined ? {} : { [TelegramChat.secretHeader]: header }
          })
        )
      ).pipe(Effect.map((response) => response.status))
  })
  const update = JSON.stringify(messageUpdate({ text: "hi" }))

  it.effect("needs the secret, then answers for the body", () =>
    Effect.gen(function*() {
      const recorder = makeRecorder()
      const send = yield* webhook(recorder)
      assert.strictEqual(yield* send(update), 401)
      assert.strictEqual(yield* send(update, "t".repeat(32)), 401)
      assert.strictEqual(recorder.events.length, 0)
      assert.strictEqual(yield* send("x".repeat(5000), secret), 413)
      assert.strictEqual(yield* send("{", secret), 400)
      assert.strictEqual(yield* send(JSON.stringify({ message: {} }), secret), 400)
      assert.strictEqual(yield* send(update, secret), 200)
      assert.strictEqual(recorder.events.length, 1)
    }))

  it.effect("answers 413 for a body that middleware read first, past the limit", () =>
    Effect.gen(function*() {
      const recorder = makeRecorder()
      const readFirst = HttpRouter.middleware(
        (httpEffect) =>
          Effect.andThen(
            Effect.ignore(Effect.flatMap(HttpServerRequest.HttpServerRequest, (r) => r.arrayBuffer)),
            httpEffect
          ),
        { global: true }
      )
      const send = yield* webhook(recorder, readFirst)
      assert.strictEqual(yield* send(JSON.stringify(messageUpdate({ text: "x".repeat(5000) })), secret), 413)
      assert.strictEqual(recorder.events.length, 0)
    }))

  it.effect("answers 503 when the handler does not accept", () =>
    Effect.gen(function*() {
      const send = yield* webhook(makeRecorder({ handle: Effect.fail(new NotAccepted({})) }))
      assert.strictEqual(yield* send(update, secret), 503)
    }))

  it.effect("keeps the secret out of server spans that capture every header, set up as the README says", () =>
    Effect.gen(function*() {
      const { spans, tracer } = spanTracer()
      const RedactSecret = Layer.effect(
        Headers.CurrentRedactedNames,
        Effect.map(Headers.CurrentRedactedNames, (names) => [...names, TelegramChat.secretHeader])
      )
      const send = yield* webhook(
        makeRecorder(),
        Layer.mergeAll(
          RedactSecret,
          Layer.succeed(HttpMiddleware.TracerHeaderFilter, () => true),
          Layer.succeed(Tracer.Tracer, tracer)
        )
      )
      assert.strictEqual(yield* send(update, secret), 200)
      const attributes = new Map(spans.find((span) => span.kind === "server")?.attributes)
      assert.strictEqual(attributes.get("http.request.header.x-telegram-bot-api-secret-token"), "<redacted>")
      assert.isFalse(JSON.stringify(spans.map((span) => [...span.attributes])).includes(secret))
    }))

  it.effect("refuses a short secret", () =>
    Effect.gen(function*() {
      const app = TelegramChat.layerWebhook({ path: "/telegram", secretToken: Redacted.make("short") }).pipe(
        Layer.provide(telegramLayer(makeApi())),
        Layer.provide(Layer.succeed(ChatHandler, makeRecorder().handler)),
        Layer.provide(HttpRouter.layer)
      )
      assert.isTrue(Exit.isFailure(yield* Layer.build(app).pipe(Effect.scoped, Effect.exit)))
    }))
})

describe("private messages", () => {
  const command = commandUpdate("deploy", "", ephemeral)

  it.effect("refuses an ephemeral answer and never posts it", () =>
    Effect.gen(function*() {
      const api = makeApi()
      const recorder = makeRecorder({ command: () => Effect.succeed(ChatInteraction.respond({ markdown: "secret" })) })
      assert.deepStrictEqual(yield* receive(api, recorder, command), ["accepted"])
      assert.deepStrictEqual(recorder.refused.map((error) => error.reason._tag), ["Unsupported"])
      assert.strictEqual(api.sent("sendRichMessage").length, 0)
      assert.strictEqual(recorder.events.length + recorder.unhandled.length, 0)
    }))

  it.effect("answers an ephemeral command in public without quoting it", () =>
    Effect.gen(function*() {
      const api = makeApi()
      const recorder = makeRecorder({
        command: () => Effect.succeed(ChatInteraction.respond({ markdown: "done", visibility: "public" }))
      })
      yield* receive(api, recorder, command)
      const [sent] = api.sent("sendRichMessage")
      assert.strictEqual(sent.chat_id, chatId)
      assert.isUndefined(sent.reply_parameters)
    }))

  it.effect("keeps an ephemeral message that is not a command from every handler", () =>
    Effect.gen(function*() {
      const recorder = makeRecorder()
      yield* receive(makeApi(), recorder, messageUpdate({ text: "psst", ...ephemeral }))
      assert.strictEqual(recorder.events.length + recorder.unhandled.length + recorder.commands.length, 0)
    }))
})

it.effect("dispatches only data from Telegram's copy of the keyboard, and answers every click", () =>
  Effect.gen(function*() {
    const api = makeApi()
    const recorder = makeRecorder()
    // A message Telegram can no longer show the bot comes with date 0.
    yield* receive(api, recorder, click("approve"), click("forged"), click("approve", 0))
    assert.deepStrictEqual(recorder.clicks.map((click) => [click.id, click.messageId]), [["approve", "5"]])
    assert.strictEqual(api.sent("answerCallbackQuery").length, 3)
  }))

it.effect("sends business and channel direct-message updates to onUnhandled, and answers their clicks", () =>
  Effect.gen(function*() {
    const api = makeApi()
    const recorder = makeRecorder()
    const business = { message_id: 3, date: 1, chat: { id: 1, type: "private" }, business_connection_id: "b" }
    const excluded = [
      messageUpdate({ text: "hi", business_connection_id: "b" }),
      messageUpdate({ text: "hi", chat: { id: chatId, type: "supergroup", is_direct_messages: true } })
    ]
    // The pure normalizer leaves them out too, not only receive.
    assert.deepStrictEqual(excluded.map((update) => TelegramChat.normalize(update, context)), [[], []])
    yield* receive(
      api,
      recorder,
      ...excluded,
      callbackUpdate({ ...business, reply_markup: { inline_keyboard: [[{ text: "a", callback_data: "a" }]] } }, "a")
    )
    assert.strictEqual(recorder.unhandled.length, 3)
    assert.strictEqual(recorder.events.length + recorder.clicks.length, 0)
    assert.strictEqual(api.sent("answerCallbackQuery").length, 1)
  }))

it("keys deliveries by bot, update and date, and by environment", () => {
  const update = messageUpdate({ text: "hi" })
  const key = (environment?: "test") => Option.getOrThrow(TelegramChat.deliveryKey(update, { botId, environment }))
  assert.strictEqual(key(), `${botId}.${update.update_id}.${update.message.date}`)
  assert.strictEqual(key("test"), `test.${key()}`)
})

it.effect("confirms a polled update only after it ran", () =>
  Effect.gen(function*() {
    const api = makeApi()
    const recorder = makeRecorder()
    const last = messageUpdate({ text: "two" })
    api.updates.push([messageUpdate({ text: "one" }), last])
    yield* Layer.build(
      TelegramChat.layerPolling().pipe(
        Layer.provideMerge(telegramLayer(api)),
        Layer.provide(Layer.succeed(ChatHandler, recorder.handler))
      )
    )
    yield* until(() => api.sent("getUpdates").length >= 2)
    const [start, next] = api.sent("getUpdates")
    assert.isUndefined(start.offset)
    assert.strictEqual(next.offset, last.update_id + 1)
    assert.strictEqual(recorder.events.length, 2)
  }))

describe("deadlines", () => {
  it.effect("answers a click at its deadline and lets its handler run on, so a late commit is never repeated", () =>
    Effect.gen(function*() {
      const api = makeApi()
      const release = yield* Deferred.make<void>()
      const steps: Array<string> = []
      const recorder = makeRecorder({
        click: Effect.andThen(
          Effect.sync(() => void steps.push("started")),
          Effect.andThen(Deferred.await(release), Effect.sync(() => void steps.push("committed")))
        )
      })
      const fiber = yield* Effect.forkChild(receive(api, recorder, click("approve")))
      yield* until(() => steps.length > 0)
      yield* TestClock.adjust("2499 millis")
      assert.strictEqual(api.sent("answerCallbackQuery").length, 0)
      yield* TestClock.adjust("1 millis")
      assert.deepStrictEqual(yield* Fiber.join(fiber), ["accepted"])
      assert.strictEqual(api.sent("answerCallbackQuery").length, 1)
      yield* Deferred.succeed(release, void 0)
      yield* until(() => steps.length > 1)
      assert.deepStrictEqual(steps, ["started", "committed"])
    }))

  it.effect("refuses a message whose handler outlives its deadline, so Telegram redelivers it", () =>
    Effect.gen(function*() {
      let started = false
      const recorder = makeRecorder({ handle: Effect.andThen(Effect.sync(() => void (started = true)), Effect.never) })
      const fiber = yield* Effect.forkChild(receive(makeApi(), recorder, messageUpdate({ text: "hi" })))
      yield* until(() => started)
      yield* TestClock.adjust("9999 millis")
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust("1 millis")
      assert.deepStrictEqual(yield* Fiber.join(fiber), ["notAccepted"])
    }))

  it.effect("interrupts a command at its deadline and still counts it answered, never as a message", () =>
    Effect.gen(function*() {
      const steps: Array<string> = []
      const recorder = makeRecorder({
        command: () => Effect.onInterrupt(Effect.never, () => Effect.sync(() => void steps.push("interrupted")))
      })
      const fiber = yield* Effect.forkChild(receive(makeApi(), recorder, commandUpdate("deploy", "prod")))
      yield* until(() => recorder.commands.length > 0)
      yield* TestClock.adjust("9999 millis")
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust("1 millis")
      assert.deepStrictEqual(yield* Fiber.join(fiber), ["accepted"])
      yield* until(() => steps.length > 0)
      assert.strictEqual(recorder.events.length + recorder.unhandled.length, 0)
    }))
})

it.effect("gives an anonymous admin's command the group as its user", () =>
  Effect.gen(function*() {
    const recorder = makeRecorder()
    // Telegram's stand-in `from` for anonymous group admins.
    const anonymous = { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" }
    yield* receive(
      makeApi(),
      recorder,
      commandUpdate("deploy", "", { from: anonymous, sender_chat: { id: -1001, type: "supergroup", title: "G" } })
    )
    assert.deepStrictEqual(recorder.commands.map((command) => command.userId), ["-1001"])
  }))

it("gives an animation one attachment, not its document copy too", () => {
  const file = { file_id: "anim", file_unique_id: "u", mime_type: "video/mp4" }
  const [event] = TelegramChat.normalize(
    messageUpdate({ animation: { ...file, width: 1, height: 1, duration: 1 }, document: file }),
    context
  )
  assert.deepStrictEqual(event._tag === "MessageCreated" ? event.message.attachments.map((a) => a.id) : [], ["anim"])
})

it.effect("commandRequests refuses ids Telegram can't register", () =>
  Effect.gen(function*() {
    const ok = ChatInteraction.group(ChatInteraction.command("deploy", { description: "Deploy" }))
    const bad = ChatInteraction.group(ChatInteraction.command("ship-it", { description: "Ship" }))
    assert.deepStrictEqual(yield* TelegramChat.commandRequests(ok), {
      commands: [{ command: "deploy", description: "Deploy" }]
    })
    assert.isTrue(Exit.isFailure(yield* Effect.exit(TelegramChat.commandRequests(bad))))
  }))

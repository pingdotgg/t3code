import { handleRequest, handleVerification, makeVerifier } from "@effect/chat-whatsapp/internal/webhook"
import * as WhatsAppChat from "@effect/chat-whatsapp/WhatsAppChat"
import type { WhatsAppUpdate } from "@effect/chat-whatsapp/WhatsAppUpdate"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Chat from "effect/chat/Chat"
import type { File } from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { NotAccepted } from "effect/chat/ChatHandler"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as ChatMarkdown from "effect/chat/ChatMarkdown"
import type { Action } from "effect/chat/ChatUi"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as Fiber from "effect/Fiber"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Redacted from "effect/Redacted"
import * as Scheduler from "effect/Scheduler"
import {
  bsuid,
  graphError,
  inbound,
  makeGraph,
  phone,
  phoneNumberId,
  statuses,
  thread,
  whatsappLayer
} from "./utils.ts"

const post = (
  content: {
    readonly markdown: string
    readonly actions?: ReadonlyArray<Action>
    readonly files?: ReadonlyArray<File>
  },
  to = thread
) => Effect.flatMap(Chat.Chat, (chat) => chat.post(to, content))

const run = <A, E>(graph: ReturnType<typeof makeGraph>, effect: Effect.Effect<A, E, Chat.Chat>) =>
  effect.pipe(Effect.provide(whatsappLayer(graph)))

const failure = <A>(graph: ReturnType<typeof makeGraph>, effect: Effect.Effect<A, ChatError, Chat.Chat>) =>
  run(graph, Effect.flip(effect)).pipe(Effect.map((error) => error.reason))

const file = (name: string, contentType: string, size = 8): File => ({
  name,
  contentType,
  content: new Uint8Array(size)
})

const button = (id: string, label: string, value?: string): Action => ({
  _tag: "Button",
  id,
  label,
  ...(value === undefined ? {} : { value })
})

describe("post", () => {
  it.effect("sends rendered text to a BSUID as recipient and a phone number as to, without a preview", () =>
    Effect.gen(function*() {
      const graph = makeGraph()
      yield* run(graph, post({ markdown: "**hi** [docs](https://e.com)" }))
      yield* run(graph, post({ markdown: "hi" }, WhatsAppChat.thread({ phoneNumberId, user: phone })))
      const [first, second] = graph.sent()
      assert.deepStrictEqual(first, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        recipient: bsuid,
        type: "text",
        text: { body: "*hi* docs (https://e.com)", preview_url: false }
      })
      assert.strictEqual(second.to, phone)
    }))

  it.effect("lays out reply buttons, a link button, a list and appended links", () =>
    Effect.gen(function*() {
      const graph = makeGraph()
      yield* run(graph, post({ markdown: "", actions: [button("a", "Yes"), button("b", "No", "v")] }))
      yield* run(graph, post({ markdown: "x", actions: [{ _tag: "LinkButton", label: "Docs", url: "https://e.com" }] }))
      yield* run(
        graph,
        post({
          markdown: "x",
          actions: [
            button("a", "Yes"),
            { _tag: "Select", id: "env", placeholder: "Environment", options: [{ label: "Prod", value: "p" }] },
            { _tag: "LinkButton", label: "Docs", url: "https://e.com" }
          ]
        })
      )
      const [reply, cta, list] = graph.sent().map((body) => body.interactive)
      assert.deepStrictEqual(reply, {
        type: "button",
        body: { text: "Yes, No" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "ba", title: "Yes" } },
            { type: "reply", reply: { id: "bb\u241Fv", title: "No" } }
          ]
        }
      })
      assert.deepStrictEqual(cta.action, {
        name: "cta_url",
        parameters: { display_text: "Docs", url: "https://e.com" }
      })
      assert.deepStrictEqual(list, {
        type: "list",
        body: { text: "x\n\nDocs: https://e.com" },
        action: {
          button: "Environment",
          sections: [
            { title: "Actions", rows: [{ id: "ba", title: "Yes" }] },
            { title: "Environment", rows: [{ id: "senv\u241Fp", title: "Prod" }] }
          ]
        }
      })
    }))

  it.effect("refuses before any call", () =>
    Effect.gen(function*() {
      const graph = makeGraph()
      const rows = Array.from({ length: 6 }, (_, i) => button("b" + i, "b" + i))
      const select: Action = {
        _tag: "Select",
        id: "s",
        options: Array.from({ length: 5 }, (_, i) => ({ label: "o" + i, value: "o" + i }))
      }
      const refusals: ReadonlyArray<readonly [Effect.Effect<unknown, ChatError, Chat.Chat>, string, string]> = [
        [post({ markdown: "x", actions: [...rows, select] }), "TooLarge", "list_rows"],
        [post({ markdown: "x", actions: [button("a", "x".repeat(25))] }), "TooLarge", "label_too_long"],
        [
          post({ markdown: "x", actions: [button("a", "Same"), button("b", "Same")] }),
          "InvalidRequest",
          "duplicate_label"
        ],
        [post({ markdown: "x", actions: [button("a\u241F", "A")] }), "InvalidRequest", "invalid_action_id"],
        // The body is the text, "\n\n" and "Docs: https://example.com": 1,027 units, over the 1,024 of reply buttons.
        [
          post({
            markdown: "x".repeat(1000),
            actions: [button("a", "Yes"), { _tag: "LinkButton", label: "Docs", url: "https://example.com" }]
          }),
          "TooLarge",
          "message_too_long"
        ],
        // The wire id "bx\u241F" + 126 "é" is 257 UTF-8 bytes, though within actionDataLength.
        [
          post({ markdown: "x", actions: [button("x", "Yes", "é".repeat(126))] }),
          "TooLarge",
          "action_data_too_long"
        ],
        [
          post({ markdown: "x" }, { platform: "whatsapp", id: phoneNumberId + "/u/not-a-user" }),
          "InvalidRequest",
          "invalid_thread"
        ],
        [
          post({ markdown: "x" }, { platform: "whatsapp", id: phoneNumberId + "/g/120363" }),
          "InvalidRequest",
          "group_unsupported"
        ],
        [
          post({ markdown: "x", files: [file("a.txt", "text/plain"), file("b.txt", "text/plain")] }),
          "TooLarge",
          "file_refused"
        ],
        [post({ markdown: "x", files: [file("a.webp", "image/webp")] }), "TooLarge", "file_refused"],
        [post({ markdown: "x", files: [file("a.png", "image/png", 5 * 1024 * 1024 + 1)] }), "TooLarge", "file_refused"],
        [post({ markdown: "x", files: [file("a.ogg", "audio/ogg")] }), "TooLarge", "file_refused"],
        [post({ markdown: "x".repeat(1025), files: [file("a.txt", "text/plain")] }), "TooLarge", "file_refused"],
        [
          post({ markdown: "x", actions: rows.slice(0, 4), files: [file("a.txt", "text/plain")] }),
          "TooLarge",
          "file_refused"
        ]
      ]
      for (const [effect, tag, detail] of refusals) {
        const reason = yield* failure(graph, effect)
        assert.deepStrictEqual([reason._tag, reason.detail], [tag, detail])
      }
      assert.deepStrictEqual(graph.calls, [])
    }))

  it.effect("names the messaging account on every send when one is configured", () =>
    Effect.gen(function*() {
      const graph = makeGraph()
      yield* Effect.gen(function*() {
        yield* post({ markdown: "hi" })
        const whatsapp = yield* WhatsAppChat.WhatsAppChat
        yield* whatsapp.sendTemplate(thread, { name: "hello", language: "en_US" })
      }).pipe(Effect.provide(whatsappLayer(graph, { messagingAccountId: "ma-1" })))
      assert.deepStrictEqual(graph.sent().map((body) => body.messaging_account_id), ["ma-1", "ma-1"])
    }))

  it.effect("uploads a file as the header of reply buttons, and Markdown as text/plain", () =>
    Effect.gen(function*() {
      const graph = makeGraph()
      yield* run(
        graph,
        post({ markdown: "notes", actions: [button("a", "Ok")], files: [file("a.md", "text/markdown")] })
      )
      const [upload, send] = graph.calls
      assert.strictEqual(upload.body.type, "text/plain")
      assert.strictEqual(upload.body.file.name, "a.md")
      assert.deepStrictEqual(send.body.interactive.header, {
        type: "document",
        document: { id: "media-1", filename: "a.md" }
      })
    }))

  it.effect("posts the text alone when Meta refuses the upload", () =>
    Effect.gen(function*() {
      const graph = makeGraph()
      graph.next.set(phoneNumberId + "/media", graphError(131053))
      yield* run(
        graph,
        ChatMarkdown.post(thread, "Report", {
          files: [file("a.txt", "text/plain")],
          unattachedNote: () => " (not attached)",
          minWriteInterval: Duration.zero
        })
      )
      assert.deepStrictEqual(graph.sent().map((body) => body.text.body), ["Report (not attached)"])
    }))

  it.effect("maps 131047 to Forbidden outside the window", () =>
    Effect.gen(function*() {
      const graph = makeGraph()
      graph.next.set(phoneNumberId + "/messages", graphError(131047))
      const reason = yield* failure(graph, post({ markdown: "x" }))
      assert.deepStrictEqual([reason._tag, reason.detail], ["Forbidden", WhatsAppChat.outsideWindow])
    }))
})

const secret = "app-secret"

const sign = async (body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  return "sha256=" + Hex.encode(mac)
}

const deliver = Effect.fnUntraced(function*(
  envelope: unknown,
  options?: {
    readonly signature?: string
    readonly refuse?: (event: ChatEvent.ChatEvent) => boolean
    readonly handle?: (event: ChatEvent.ChatEvent) => Effect.Effect<void>
    readonly onClick?: ChatInteraction.ClickReply
    readonly onRefused?: (error: ChatError) => Effect.Effect<void>
    readonly deadline?: Duration.Duration
    readonly maxBodySize?: ByteSize.ByteSize
    /** Read the whole body first, as a middleware might. */
    readonly readFirst?: boolean
  }
) {
  const body = JSON.stringify(envelope)
  const signature = options?.signature ?? (yield* Effect.promise(() => sign(body)))
  const verify = yield* makeVerifier(Redacted.make(secret)).pipe(Effect.provide(NodeCrypto.layerMac))
  const seen: Array<string> = []
  const clicks: Array<ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged> = []
  const refused: Array<ChatError> = []
  const request = HttpServerRequest.fromWeb(
    new Request("http://localhost/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": signature } })
  )
  if (options?.readFirst === true) yield* request.arrayBuffer
  const response = yield* handleRequest(
    request,
    {
      verify,
      normalize: (envelope) => WhatsAppChat.normalize(envelope, { phoneNumberId }),
      handle: (event) =>
        options?.refuse?.(event) === true
          ? Effect.fail(new NotAccepted({}))
          : options?.handle !== undefined
          ? options.handle(event)
          : Effect.sync(() => void seen.push(event._tag)),
      onUpdate: (update: WhatsAppUpdate) => Effect.sync(() => void seen.push(update._tag)),
      deadline: options?.deadline ?? Duration.seconds(4),
      maxBodySize: options?.maxBodySize ?? ByteSize.mebibytes(1)
    }
  ).pipe(Effect.provideService(
    ChatInteraction.Handler,
    ChatInteraction.Handler.of({
      click: (event) =>
        Effect.sync(() => (seen.push(event._tag), clicks.push(event), options?.onClick ?? ChatInteraction.ack)),
      submit: () => Effect.succeed(ChatInteraction.close),
      command: () => Effect.succeed(ChatInteraction.ack),
      refused: (_, error) =>
        Effect.andThen(Effect.sync(() => void refused.push(error)), options?.onRefused?.(error) ?? Effect.void)
    })
  ))
  return { status: response.status, seen, clicks, refused }
})

describe("webhook", () => {
  const text = inbound({ type: "text", text: { body: "hi" } })

  it.effect("checks the signature and answers Meta's subscription check", () =>
    Effect.gen(function*() {
      assert.strictEqual((yield* deliver(text, { signature: "sha256=00" })).status, 401)
      assert.strictEqual((yield* deliver(text)).status, 200)
      const check = (token: string) =>
        handleVerification(
          HttpServerRequest.fromWeb(
            new Request(`http://localhost/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`)
          ),
          Redacted.make("verify")
        ).status
      assert.deepStrictEqual([check("verify"), check("other")], [200, 403])
    }))

  it.effect("answers 413 past the body limit, also for a body read earlier", () =>
    Effect.gen(function*() {
      for (const readFirst of [false, true]) {
        const result = yield* deliver(text, { maxBodySize: ByteSize.bytes(100), readFirst })
        assert.deepStrictEqual([result.status, result.seen], [413, []], `readFirst: ${readFirst}`)
      }
    }))

  it.effect("runs updates in order, drops a removed reaction and stops at NotAccepted with a 503", () =>
    Effect.gen(function*() {
      const batch = inbound({ type: "text", text: { body: "hi" } })
      const value = batch.entry[0].changes[0].value as any
      value.messages.push(
        { ...value.messages[0], id: "wamid.r1", type: "reaction", reaction: { message_id: "wamid.out1", emoji: "" } },
        { ...value.messages[0], id: "wamid.r2", type: "reaction", reaction: { message_id: "wamid.out1", emoji: "👍" } }
      )
      value.statuses = [{
        id: "wamid.out1",
        status: "read",
        timestamp: "1794600001",
        recipient_id: phone,
        recipient_user_id: bsuid
      }]
      const ok = yield* deliver(batch)
      assert.deepStrictEqual([ok.status, ok.seen], [200, ["MessageCreated", "ReactionAdded", "Status", "Alias"]])
      const refused = yield* deliver(batch, { refuse: (event) => event._tag === "MessageCreated" })
      assert.deepStrictEqual([refused.status, refused.seen], [503, []])
    }))

  it.live("answers 503 at the deadline without waiting for a slow finalizer", () =>
    Effect.gen(function*() {
      const start = Date.now()
      const result = yield* deliver(text, {
        handle: () => Effect.never.pipe(Effect.ensuring(Effect.sleep("5 seconds"))),
        deadline: Duration.millis(50)
      })
      assert.strictEqual(result.status, 503)
      assert.isBelow(Date.now() - start, 2000)
    }))

  it.live("interrupts the worker when the request is cancelled at any step", () =>
    Effect.gen(function*() {
      // Each budget makes the request yield, and be cancelled, at a different step.
      for (let budget = 1; budget <= 40; budget++) {
        let started = false
        let stopped = false
        const request = handleRequest(
          HttpServerRequest.fromWeb(new Request("http://localhost/whatsapp", { method: "POST", body: "{}" })),
          {
            verify: () =>
              Effect.andThen(
                Effect.sync(() => (started = true)),
                Effect.onInterrupt(Effect.never, () => Effect.sync(() => (stopped = true)))
              ),
            normalize: () => [],
            handle: () => Effect.void,
            deadline: Duration.seconds(4),
            maxBodySize: ByteSize.kibibytes(1)
          }
        ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))
        const fiber = yield* Effect.forkChild(request, { startImmediately: true })
        yield* Fiber.interrupt(fiber)
        yield* Effect.sleep("20 millis")
        assert.isFalse(started && !stopped, `MaxOpsBeforeYield ${budget}`)
      }
    }))

  it.live("hands a click to the handler and refuses a modal as Unsupported", () =>
    Effect.gen(function*() {
      const click = inbound({
        type: "interactive",
        context: { from: "15550783881", id: "wamid.out1" },
        interactive: { type: "list_reply", list_reply: { id: "senv\u241Fp\u241Fq", title: "Prod" } }
      })
      const modal = ChatInteraction.modal("m", { title: "M", fields: {} }).open()
      const refusal = yield* Deferred.make<ChatError>()
      // The refusal callback never finishes, and the click is still answered 200.
      const result = yield* deliver(click, {
        onClick: modal,
        onRefused: (error) => Effect.andThen(Deferred.succeed(refusal, error), Effect.never),
        deadline: Duration.millis(500)
      })
      assert.deepStrictEqual([result.status, result.seen], [200, ["SelectChanged"]])
      const [event] = result.clicks
      assert.deepStrictEqual(event._tag === "SelectChanged" && [event.id, event.value, event.messageId], [
        "env",
        "p\u241Fq",
        "wamid.out1"
      ])
      // The key is the webhook message's id, not the clicked card's.
      assert.strictEqual(
        WhatsAppChat.deliveryKey(event),
        `${phoneNumberId}/${click.entry[0].changes[0].value.messages[0].id}`
      )
      assert.strictEqual((yield* Deferred.await(refusal)).reason._tag, "Unsupported")
    }))
})

describe("normalize", () => {
  it("reports a changed BSUID that arrives with no sender or contact", () => {
    const envelope = inbound({
      type: "system",
      system: { type: "user_changed_user_id", user_id: "US.99", body: "changed" }
    })
    const value = envelope.entry[0].changes[0].value as any
    delete value.contacts
    delete value.messages[0].from
    delete value.messages[0].from_user_id
    const [update] = WhatsAppChat.normalize(envelope, { phoneNumberId })
    assert.deepStrictEqual(
      update._tag === "UserIdChanged" && [update.thread.id, update.userId, WhatsAppChat.updateKey(update)],
      [
        `${phoneNumberId}/u/US.99`,
        "US.99",
        `${phoneNumberId}/user_changed/${value.messages[0].id}`
      ]
    )
  })
})

describe("keys", () => {
  it("keys an update by its parts, escaped", () => {
    const updates = WhatsAppChat.normalize(
      statuses({ id: "wamid.a/b", status: "delivered", recipient_id: phone, recipient_user_id: bsuid }),
      { phoneNumberId }
    )
    assert.deepStrictEqual(
      updates.map((update) =>
        update._tag === "Status" || update._tag === "Alias" ? WhatsAppChat.updateKey(update) : ""
      ),
      [
        `${phoneNumberId}/status/wamid.a%2Fb/delivered`,
        `${phoneNumberId}/alias/wamid.a%2Fb/delivered/${phone}/${bsuid}`
      ]
    )
  })
})

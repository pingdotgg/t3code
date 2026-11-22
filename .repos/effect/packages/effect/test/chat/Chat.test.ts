import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Tracer } from "effect"
import { Chat, ChatTest, ChatThread } from "effect/chat"

const recordSpans = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return { spans, tracer }
}

describe("Chat", () => {
  it.effect("routes each address to its platform's adapter", () =>
    Effect.gen(function*() {
      const chat = yield* Chat.Chat
      const test = yield* ChatTest.ChatTest
      const b = yield* test.makeThread()
      yield* chat.post(b, { markdown: "to b" })
      const missing = yield* Effect.flip(chat.post(ChatThread.make("c", "x"), { markdown: "nowhere" }))
      assert.strictEqual(missing.reason._tag, "NoAdapter")
      assert.deepStrictEqual((yield* test.messages(b)).map((message) => message.text), ["to b"])
    }).pipe(Effect.provide(Layer.mergeAll(ChatTest.layer({ platform: "a" }), ChatTest.layer({ platform: "b" })))))

  it.effect("sets only platform, op, error reason and retry value on its spans", () =>
    Effect.gen(function*() {
      const { spans, tracer } = recordSpans()
      const chat = yield* Chat.Chat
      const test = yield* ChatTest.ChatTest
      const thread = yield* test.makeThread()
      yield* Effect.gen(function*() {
        const posted = yield* chat.post(thread, { markdown: "hello" })
        yield* Effect.exit(chat.fetchMessage(thread, posted.id + "0"))
      }).pipe(Effect.withTracer(tracer))
      assert.deepStrictEqual(
        spans.map((span) => [span.name, Object.fromEntries(span.attributes)]),
        [
          ["Chat.post", { "chat.platform": "test", "chat.op": "post" }],
          ["Chat.fetchMessage", {
            "chat.platform": "test",
            "chat.op": "fetchMessage",
            "chat.error.reason": "NotFound",
            "chat.error.retry": "denied"
          }]
        ]
      )
    }).pipe(Effect.provide(ChatTest.layer())))
})

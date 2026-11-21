import { assert, describe, it } from "@effect/vitest"
import { type Cause, Deferred, Duration, Effect, Fiber, Queue, Stream } from "effect"
import { Chat, ChatAdapter, ChatError, ChatInteraction, ChatMarkdown, ChatTest } from "effect/chat"
import type { ChatThread, ChatUi } from "effect/chat"
import { TestClock } from "effect/testing"

const codePoints = (markdown: string) => [...markdown].length

const joined = (parts: ReadonlyArray<ChatMarkdown.Part>) => parts.map((part) => part.text).join("")

const paragraphs = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => ("Paragraph " + i + " ").padEnd(size, "x")).join("\n\n")

const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

const setup = Effect.gen(function*() {
  const test = yield* ChatTest.ChatTest
  const thread = yield* test.makeThread()
  return { test, thread }
})

const texts = (test: ChatTest.ChatTest["Service"], thread: ChatThread.ChatThread) =>
  Effect.map(test.messages(thread), (messages) => messages.map((message) => message.text))

/** Runs `stream` over a queue the test feeds, ends or fails. */
const feed = Effect.fnUntraced(function*(
  thread: ChatThread.ChatThread,
  options?: ChatMarkdown.Options<never> & { readonly recipient?: string | undefined }
) {
  const queue = yield* Queue.unbounded<string, string | Cause.Done>()
  const fiber = yield* Effect.forkChild(ChatMarkdown.stream(thread, Stream.fromQueue(queue), options))
  const send = (chunk: string) => Effect.andThen(Queue.offer(queue, chunk), settle)
  const fail = (error: string) => Effect.andThen(Queue.fail(queue, error), settle)
  const close = Effect.andThen(Queue.end(queue), settle)
  const end = Effect.andThen(Queue.end(queue), Fiber.join(fiber))
  return { fiber, send, fail, close, end }
})

/** Registers the test adapter with its native stream changed by `f`. */
const patchNative = Effect.fnUntraced(function*(
  f: (native: ChatAdapter.NativeStream) => Partial<ChatAdapter.NativeStream>
) {
  const test = yield* ChatTest.ChatTest
  const registry = yield* ChatAdapter.Registry
  const adapter = yield* registry.get(test.platform)
  const native = adapter.nativeStream!
  yield* registry.register({ ...adapter, nativeStream: { ...native, ...f(native) } })
})

/** Holds the first native `append` or `stop` until `release` completes. */
const holdFirst = Effect.fnUntraced(function*(op: "append" | "stop") {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let first = true
  const hold = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      if (!first) return effect
      first = false
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(effect))
    })
  yield* patchNative((native) =>
    op === "append"
      ? { append: (...args) => hold(native.append(...args)) }
      : { stop: (...args) => hold(native.stop(...args)) }
  )
  return { entered, release }
})

describe("ChatMarkdown", () => {
  describe("post", () => {
    it.effect("splits at block boundaries", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const input = paragraphs(10, 40)
        const result = yield* ChatMarkdown.post(thread, input, { maxParts: 10 })
        assert.isTrue(result.parts.length > 1)
        assert.strictEqual(joined(result.parts), input)
        for (const part of result.parts) assert.isAtMost(codePoints(part.markdown), 100)
        for (const part of result.parts.slice(0, -1)) assert.isTrue(part.text.endsWith("\n\n"), part.text)
        assert.deepStrictEqual(yield* texts(test, thread), result.parts.map((part) => part.markdown))
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 100 } }))))

    it.effect("keeps a fenced block that exactly fits in one message", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const block = "```\nx\n```\n"
        yield* ChatMarkdown.post(thread, block + "rest", { maxParts: 2 })
        assert.deepStrictEqual(yield* texts(test, thread), [block, "rest"])
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 10 } }))))

    it.effect("closes a code fence and reopens it in the next part", () =>
      Effect.gen(function*() {
        const { thread } = yield* setup
        const input = "```ts\n" + "const a = 1\n".repeat(10) + "```\n"
        const result = yield* ChatMarkdown.post(thread, input)
        assert.isTrue(result.parts.length > 1)
        assert.strictEqual(joined(result.parts), input)
        assert.isTrue(result.parts[0].markdown.endsWith("\n```"), result.parts[0].markdown)
        for (const part of result.parts.slice(1)) assert.isTrue(part.markdown.startsWith("```ts\n"), part.markdown)
        for (const part of result.parts) assert.isAtMost(codePoints(part.markdown), 60)
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 60 } }))))

    it.effect("replies with the first part only", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const event = yield* test.userPosts(thread, { text: "question" })
        assert(event._tag === "MessageCreated")
        const replyTo = { messageId: event.message.id }
        const result = yield* ChatMarkdown.post(thread, paragraphs(3, 20), { replyTo })
        const messages = yield* test.messages(thread)
        const replies = result.parts.map((part) => messages.find((message) => message.id === part.messageId)?.replyTo)
        assert.deepStrictEqual(replies.map((reply) => reply?.messageId), [event.message.id, undefined, undefined])
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 } }))))

    it.effect("remainingFence is the fence remaining was cut in, and reopening it gives the rest back", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const code = Array.from({ length: 6 }, (_, i) => "const line" + i + " = " + i).join("\n")
        const input = "Intro\n\n~~~ts title\n" + code + "\n~~~\n\nOutro"
        const error = yield* Effect.flip(ChatMarkdown.post(thread, input, { maxParts: 2 }))
        assert.strictEqual(error.cause._tag, "Overflow")
        assert.strictEqual(joined(error.posted) + error.remaining, input)
        assert.isTrue(error.remaining.startsWith("const line"), error.remaining)
        assert.strictEqual(error.remainingFence, "~~~ts title")
        // Sent again with the fence reopened, the thread reads as the input does.
        yield* ChatMarkdown.post(thread, error.remainingFence + "\n" + error.remaining)
        const sent = yield* texts(test, thread)
        assert.isTrue(sent.every((text) => (text.match(/^~~~/gm) ?? []).length % 2 === 0), sent.join("\n---\n"))
        assert.deepStrictEqual(
          sent.flatMap((text) => text.split("\n")).filter((line) => line.startsWith("const line")),
          code.split("\n")
        )
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 60 } }))))

    const files = [{ name: "a.txt", contentType: "text/plain", content: new TextEncoder().encode("a") }]

    it.effect("ends in the unattached note when the files are refused", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        yield* test.failNext("post", new ChatError.Forbidden({ detail: "file_refused" }))
        const result = yield* ChatMarkdown.post(thread, "Report", {
          files,
          unattachedNote: (files) => "\n\n(" + files.length + " file not attached)"
        })
        assert.deepStrictEqual(result.parts.map((part) => [part.markdown, part.text]), [[
          "Report\n\n(1 file not attached)",
          "Report"
        ]])
        const messages = yield* test.messages(thread)
        assert.deepStrictEqual(messages.map((message) => message.attachments.length), [0])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("fails on a TooLarge that does not blame the files", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        yield* test.failNext("post", new ChatError.TooLarge({ detail: "msg_blocks_too_long" }))
        const error = yield* Effect.flip(ChatMarkdown.post(thread, "Report", {
          files,
          unattachedNote: () => " (file not attached)"
        }))
        assert.strictEqual(error.cause._tag === "Chat" && error.cause.error.reason._tag, "TooLarge")
        assert.deepStrictEqual([error.posted, error.uncertain, error.remaining], [[], undefined, "Report"])
        assert.deepStrictEqual(yield* texts(test, thread), [])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("does not post a note for an uncertain file write", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        yield* test.failNext("post", new ChatError.Transport({ retry: "uncertain", detail: "file_refused" }), {
          landed: true
        })
        const error = yield* Effect.flip(ChatMarkdown.post(thread, "Report", {
          files,
          unattachedNote: () => " (file not attached)"
        }))
        assert.deepStrictEqual([error.posted, error.uncertain, error.remaining], [[], "Report", ""])
        assert.deepStrictEqual(yield* texts(test, thread), ["Report"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("keeps the files and blank text that follow the last cut", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const input = "abcde\n\n"
        const result = yield* ChatMarkdown.post(thread, input, { files })
        assert.deepStrictEqual(result.parts.map((part) => [part.markdown, part.text]), [["abcde", input]])
        const messages = yield* test.messages(thread)
        assert.deepStrictEqual(messages.map((message) => message.attachments.length), [1])
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 5 } }))))

    it.effect("preserves overflow as text when files are refused", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        yield* test.refuseFiles({ times: 2 })
        const input = paragraphs(5, 20)
        const result = yield* ChatMarkdown.post(thread, input, {
          files,
          maxParts: 1,
          overflow: { file: { name: "rest.md" } },
          unattachedNote: () => " (not attached)"
        })
        assert.strictEqual(joined(result.parts), input)
        const messages = yield* test.messages(thread)
        assert.strictEqual(messages.map((message) => message.text).join(""), input + " (not attached)")
        assert.isTrue(messages.every((message) => message.attachments.length === 0))
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 } }))))

    it.effect("sends the files with the overflow file", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const input = paragraphs(5, 20)
        const result = yield* ChatMarkdown.post(thread, input, {
          files,
          maxParts: 2,
          overflow: { file: { name: "rest.md" } }
        })
        assert.deepStrictEqual(result.parts.map((part) => part.kind), ["text", "text", "overflowFile"])
        assert.strictEqual(joined(result.parts), input)
        const last = (yield* test.messages(thread)).at(-1)!
        assert.deepStrictEqual(last.attachments.map((attachment) => attachment.name), ["rest.md", "a.txt"])
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 } }))))

    const button = ChatInteraction.button("go", { label: "Go" }).of()
    /** One element costs `cost`, so a test can leave as little room beside it as it needs. */
    const costing = (cost: number) => (markdown: string, actions?: ReadonlyArray<ChatUi.Action>) =>
      codePoints(markdown) + cost * (actions?.length ?? 0)

    it.effect("fails TooLarge before posting when the actions alone do not fit", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const error = yield* Effect.flip(ChatMarkdown.post(thread, "a", { actions: [button] }))
        assert.strictEqual(error.cause._tag === "Chat" && error.cause.error.reason._tag, "TooLarge")
        assert.deepStrictEqual(yield* test.messages(thread), [])
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 9 }, measure: costing(10) }))))

    it.effect("fills the parts before the last one without leaving room for the actions", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const result = yield* ChatMarkdown.post(thread, "a".repeat(25), { actions: [button] })
        assert.deepStrictEqual(result.parts.map((part) => part.text), ["a".repeat(24), "a"])
        yield* test.click(result.parts[1].messageId, "go")
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 }, measure: costing(29) }))))

    it.effect("posts the actions in a message of their own when no text fits beside them", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const result = yield* ChatMarkdown.post(thread, "Hello", { actions: [button], files })
        assert.deepStrictEqual(result.parts.map((part) => part.text), ["Hello", ""])
        const messages = yield* test.messages(thread)
        assert.deepStrictEqual(messages.map((message) => [message.text, message.attachments.length]), [
          ["Hello", 0],
          ["", 1]
        ])
        assert.strictEqual((yield* Effect.flip(test.click(result.parts[0].messageId, "go")))._tag, "NoSuchElement")
        yield* test.click(result.parts[1].messageId, "go")
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 }, measure: costing(30) }))))

    it.effect("fails Overflow when the actions' own message has no part left", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const error = yield* Effect.flip(ChatMarkdown.post(thread, "Hello", { actions: [button], maxParts: 1 }))
        assert.strictEqual(error.cause._tag, "Overflow")
        assert.deepStrictEqual([error.posted.map((part) => part.text), error.remaining], [["Hello"], ""])
        assert.strictEqual((yield* test.messages(thread)).length, 1)
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 }, measure: costing(30) }))))

    it.effect("moves the actions to an unattached note posted on its own", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        yield* test.failNext("post", new ChatError.Forbidden({ detail: "file_refused" }))
        const result = yield* ChatMarkdown.post(thread, "a".repeat(20), {
          actions: [button],
          files,
          unattachedNote: () => " note"
        })
        assert.deepStrictEqual(result.parts.map((part) => part.markdown), ["a".repeat(20), " note"])
        assert.strictEqual((yield* Effect.flip(test.click(result.parts[0].messageId, "go")))._tag, "NoSuchElement")
        yield* test.click(result.parts[1].messageId, "go")
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 }, measure: costing(10) }))))

    it.effect("posts the actions after an unattached note that has no room for them", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        yield* test.failNext("post", new ChatError.Forbidden({ detail: "file_refused" }))
        const result = yield* ChatMarkdown.post(thread, "a".repeat(20), {
          actions: [button],
          files,
          unattachedNote: () => "n".repeat(25)
        })
        assert.deepStrictEqual(result.parts.map((part) => part.markdown), ["a".repeat(20), "n".repeat(25), ""])
        for (const part of result.parts.slice(0, 2)) {
          assert.strictEqual((yield* Effect.flip(test.click(part.messageId, "go")))._tag, "NoSuchElement")
        }
        yield* test.click(result.parts[2].messageId, "go")
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 }, measure: costing(10) }))))

    it.effect("never cuts inside a grapheme cluster on a hard cut", () =>
      Effect.gen(function*() {
        const { thread } = yield* setup
        // The 10th code unit is the "e" of "e\u0301", and the flag is two code points of one cluster.
        const input = "aaaaaaaaae\u0301bbbbbbb\u{1F1EF}\u{1F1F5}cc"
        const result = yield* ChatMarkdown.post(thread, input)
        assert.strictEqual(joined(result.parts), input)
        assert.deepStrictEqual(result.parts.map((part) => part.text), [
          "aaaaaaaaa",
          "e\u0301bbbbbbb",
          "\u{1F1EF}\u{1F1F5}cc"
        ])
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 10 } }))))

    it.effect("keeps message text out of the error's message and JSON", () =>
      Effect.gen(function*() {
        const { thread } = yield* setup
        const error = yield* Effect.flip(ChatMarkdown.post(thread, paragraphs(5, 20), { maxParts: 1 }))
        assert.notInclude(error.message, "Paragraph")
        assert.notInclude(JSON.stringify(error.toJSON()), "Paragraph")
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 30 } }))))
  })

  describe("stream", () => {
    it.effect("posts each part once, when it is final, without edit", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { end, send } = yield* feed(thread)
        yield* send("one\n\n")
        assert.deepStrictEqual(yield* test.calls, [])
        yield* send("two ".repeat(10) + "\n\nthree")
        const result = yield* end
        assert.deepStrictEqual(result.parts.map((part) => part.transport), ["post", "post"])
        assert.deepStrictEqual(yield* texts(test, thread), ["one\n\n" + "two ".repeat(10) + "\n\n", "three"])
      }).pipe(Effect.provide(ChatTest.layer({ capabilities: ["files"], limits: { messageLength: 50 } }))))

    it.effect("writes natively with a recipient, sending held text again", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { end, send } = yield* feed(thread, { recipient: "U1" })
        yield* send("hello\n")
        yield* send("x < y\n")
        yield* send("```ts\ncode")
        const result = yield* end
        assert.deepStrictEqual(result.parts.map((part) => [part.transport, part.text]), [[
          "native",
          "hello\nx < y\n```ts\ncode"
        ]])
        assert.deepStrictEqual(yield* texts(test, thread), ["hello\nx < y\n```ts\ncode\n```"])
        const calls = yield* test.calls
        assert.deepStrictEqual(calls.map((call) => [call.op, call.markdown]), [
          ["nativeStream.start", "hello\n"],
          ["nativeStream.append", "x < y\n"],
          ["nativeStream.append", "< y\n```ts\ncod"],
          ["nativeStream.append", "< y\n```ts\ncode\n```"],
          ["nativeStream.stop", undefined]
        ])
      }).pipe(Effect.provide(ChatTest.layer())))

    for (
      const [where, prefix, first, rest, whole, close] of [
        // A delta that ends in half a surrogate pair, inside a fence where whole lines are not held.
        ["inside a fence", "~~~\n", "🇺\uD83C", "\uDDF8", "🇺🇸", "\n~~~"],
        // A line past the hold limit with no whitespace to release up to.
        ["in a long line", "x".repeat(301), "1", "\uFE0F\u20E3", "1️⃣", ""]
      ]
    ) {
      it.effect(`holds a grapheme cluster split across deltas ${where}`, () =>
        Effect.gen(function*() {
          const { test, thread } = yield* setup
          const { end, send } = yield* feed(thread, { recipient: "U1" })
          yield* send(prefix + first)
          assert.deepStrictEqual((yield* test.calls).map((call) => call.markdown), [prefix])
          yield* send(rest + "\n")
          assert.deepStrictEqual((yield* test.calls).map((call) => call.markdown), [prefix, whole + "\n"])
          yield* send("z")
          const result = yield* end
          assert.strictEqual(joined(result.parts), prefix + whole + "\nz")
          assert.deepStrictEqual(yield* texts(test, thread), [prefix + whole + "\nz" + close])
        }).pipe(Effect.provide(ChatTest.layer())))
    }

    it.effect("rolls a native stream over at a block boundary", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { end, send } = yield* feed(thread, { recipient: "U1" })
        const input = paragraphs(6, 28) + "\n\n"
        for (const chunk of input.split(/(?<=\n\n)/)) yield* send(chunk)
        const result = yield* end
        assert.isTrue(result.parts.length > 1)
        assert.strictEqual(joined(result.parts), input)
        for (const part of result.parts) {
          assert.strictEqual(part.transport, "native")
          assert.isTrue(part.text.endsWith("\n\n"), part.text)
        }
        const messages = yield* texts(test, thread)
        assert.deepStrictEqual(messages, result.parts.map((part) => part.markdown))
        for (const message of messages) assert.isAtMost(codePoints(message), 100)
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 100 } }))))

    it.effect("forces a rollover on a TooLarge append", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { end, send } = yield* feed(thread, { recipient: "U1" })
        yield* send("one\n")
        yield* test.failNext("nativeStream.append", new ChatError.TooLarge({ detail: "msg_too_long" }))
        yield* send("two\n")
        const result = yield* end
        assert.deepStrictEqual(result.parts.map((part) => part.text), ["one\n", "two\n"])
        assert.deepStrictEqual(yield* texts(test, thread), ["one\n", "two\n"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("falls back to post-then-edit when the start is Unsupported, closing an open fence", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        yield* test.failNext("nativeStream.start", new ChatError.Unsupported({ capability: "nativeStream" }))
        const result = yield* ChatMarkdown.stream(thread, Stream.make("one\n", "```ts\ncode"), { recipient: "U1" })
        assert.deepStrictEqual(result.parts.map((part) => part.transport), ["edit"])
        assert.deepStrictEqual(yield* texts(test, thread), ["one\n```ts\ncode\n```"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("ends the reply stopped when an append comes back stopped", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const ids: Array<string> = []
        const { fiber, send } = yield* feed(thread, {
          recipient: "U1",
          onPart: (part) => Effect.sync(() => ids.push(part.messageId))
        })
        yield* send("one\n")
        yield* test.clickStop(ids[0])
        yield* test.closeStream(ids[0])
        yield* send("two\n")
        const result = yield* Fiber.join(fiber)
        assert.isTrue(result.stopped)
        assert.strictEqual(joined(result.parts), "one\n")
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("carries on by edit when the stream is closed", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const ids: Array<string> = []
        const { end, send } = yield* feed(thread, {
          recipient: "U1",
          onPart: (part) => Effect.sync(() => ids.push(part.messageId))
        })
        yield* send("one\n")
        yield* test.closeStream(ids[0])
        yield* send("two\n")
        const result = yield* end
        assert.deepStrictEqual(result.parts.map((part) => [part.transport, part.text]), [["native", "one\ntwo\n"]])
        assert.deepStrictEqual(yield* texts(test, thread), ["one\ntwo\n"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("does not post again when interrupted while onPart runs", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const { fiber, send } = yield* feed(thread, {
          recipient: "U1",
          onPart: () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))
        })
        yield* send("hello\n")
        yield* Deferred.await(entered)
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(fiber))
        yield* settle
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupt)
        assert.deepStrictEqual(yield* texts(test, thread), ["hello\n"])
        assert.include((yield* test.calls).map((call) => call.op), "nativeStream.stop")
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("repairs with the retried chunk while the upstream is paused", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { send } = yield* feed(thread, { recipient: "U1" })
        yield* send("one\n")
        yield* test.failNext("nativeStream.append", new ChatError.RateLimited({ retryAfter: Duration.millis(100) }), {
          times: 3
        })
        yield* send("two\n")
        yield* TestClock.adjust("200 millis")
        yield* settle
        const ops = (yield* test.calls).map((call) => call.op)
        assert.strictEqual(ops.filter((op) => op === "nativeStream.append").length, 3)
        assert.include(ops, "nativeStream.stop")
        assert.deepStrictEqual(yield* texts(test, thread), ["one\ntwo\n"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("partitions an uncertain repair followed by a denied edit", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { fiber, send } = yield* feed(thread, { recipient: "U1" })
        yield* send("one\n")
        yield* test.failNext("nativeStream.append", new ChatError.Unknown({}), { landed: true })
        yield* test.failNext("edit", new ChatError.Unknown({}), { landed: true })
        yield* send("two\n")
        yield* test.failNext("edit", new ChatError.Forbidden({}))
        yield* send("three\n")
        const error = yield* Effect.flip(Fiber.join(fiber))
        assert.deepStrictEqual([joined(error.posted), error.uncertain, error.remaining], ["one\n", "two\n", "three\n"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("leaves room in a native stream to close a code fence", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { end, send } = yield* feed(thread, { recipient: "U1" })
        yield* send("~~~\n")
        yield* send("a".repeat(16))
        const result = yield* end
        assert.strictEqual(joined(result.parts), "~~~\n" + "a".repeat(16))
        const messages = yield* texts(test, thread)
        assert.isTrue(messages.length > 1)
        for (const message of messages) {
          assert.isTrue(message.endsWith("\n~~~"), message)
          assert.isAtMost(codePoints(message), 20)
        }
      }).pipe(Effect.provide(ChatTest.layer({ limits: { messageLength: 20 } }))))

    it.effect("takes the text that arrived while waiting for the write interval", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { end, send } = yield* feed(thread)
        yield* send("a\n")
        yield* send("b\n")
        yield* send("c\n")
        yield* TestClock.adjust("1 second")
        yield* settle
        const calls = yield* test.calls
        assert.deepStrictEqual(calls.map((call) => [call.op, call.markdown]), [["post", "a\n"], ["edit", "a\nb\nc\n"]])
        const ended = yield* Effect.forkChild(end)
        yield* settle
        yield* TestClock.adjust("1 second")
        const result = yield* Fiber.join(ended)
        assert.strictEqual(joined(result.parts), "a\nb\nc\n")
      }).pipe(Effect.provide(ChatTest.layer({ limits: { minWriteInterval: Duration.seconds(1) } }))))

    it.effect("a rotated stream's start names the part it continues", () =>
      Effect.gen(function*() {
        const { thread } = yield* setup
        const continues: Array<string | undefined> = []
        yield* patchNative((native) => ({
          start: (thread, options) =>
            Effect.suspend(() => {
              continues.push(options.continues)
              return native.start(thread, options)
            })
        }))
        const { end, send } = yield* feed(thread, { recipient: "U1" })
        yield* send("one\n")
        yield* TestClock.adjust("9 minutes")
        yield* send("two\n")
        const result = yield* end
        assert.deepStrictEqual(continues, [undefined, result.parts[0].messageId])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("sends a stop again when interrupted during it", () =>
      Effect.gen(function*() {
        const { thread } = yield* setup
        const chat = yield* Chat.Chat
        const { entered } = yield* holdFirst("stop")
        const ids: Array<string> = []
        const { close, fiber, send } = yield* feed(thread, {
          recipient: "U1",
          onPart: (part) => Effect.sync(() => void ids.push(part.messageId))
        })
        yield* send("hello\n")
        yield* close
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        // An open native stream would refuse the edit.
        yield* chat.edit(thread, ids[0], { markdown: "edited" })
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("keeps a rollover due after an append that was in flight when interrupted", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { entered, release } = yield* holdFirst("append")
        const { fiber, send } = yield* feed(thread, { recipient: "U1" })
        yield* send("~~~\none\n")
        yield* TestClock.adjust("9 minutes")
        yield* send("two\n")
        yield* Deferred.await(entered)
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(fiber))
        yield* settle
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupt)
        assert.deepStrictEqual(yield* texts(test, thread), ["~~~\none\n~~~", "~~~\ntwo\n~~~"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("bounds an append in flight when the upstream fails", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const { entered, release } = yield* holdFirst("append")
        const { fail, fiber, send } = yield* feed(thread, { recipient: "U1" })
        yield* send("one\n")
        yield* send("two\n")
        yield* Deferred.await(entered)
        yield* fail("boom")
        yield* TestClock.adjust("6 seconds")
        const finished = fiber.pollUnsafe() !== undefined
        yield* Deferred.succeed(release, undefined)
        const error = yield* Effect.flip(Fiber.join(fiber))
        assert.isTrue(finished)
        assert.deepStrictEqual(error.cause, { _tag: "Upstream", error: "boom" })
        assert.deepStrictEqual([joined(error.posted), error.uncertain, error.remaining], ["one\n", "two\n", ""])
        yield* settle
        assert.deepStrictEqual(yield* texts(test, thread), ["one\n"])
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("stops the stream after a denied append when the upstream then fails", () =>
      Effect.gen(function*() {
        const { test, thread } = yield* setup
        const chat = yield* Chat.Chat
        const { entered, release } = yield* holdFirst("stop")
        const ids: Array<string> = []
        const { fail, fiber, send } = yield* feed(thread, {
          recipient: "U1",
          onPart: (part) => Effect.sync(() => void ids.push(part.messageId))
        })
        yield* send("one\n")
        yield* test.failNext("nativeStream.append", new ChatError.Forbidden({}))
        yield* send("two\n")
        yield* Deferred.await(entered)
        yield* fail("boom")
        yield* Deferred.succeed(release, undefined)
        const error = yield* Effect.flip(Fiber.join(fiber))
        assert.strictEqual(error.cause._tag === "Chat" && error.cause.error.reason._tag, "Forbidden")
        assert.deepStrictEqual([joined(error.posted), error.uncertain, error.remaining], ["one\n", undefined, "two\n"])
        assert.deepStrictEqual(yield* texts(test, thread), ["one\n"])
        // An open native stream would refuse the edit.
        yield* chat.edit(thread, ids[0], { markdown: "edited" })
      }).pipe(Effect.provide(ChatTest.layer())))
  })
})

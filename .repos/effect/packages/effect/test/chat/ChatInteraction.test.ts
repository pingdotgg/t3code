import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Scheduler, Schema } from "effect"
import { Chat, ChatError, ChatInteraction, ChatTest, ChatThread } from "effect/chat"
import { TestClock } from "effect/testing"

const Deploy = Schema.Struct({ version: Schema.String })
const thread = ChatThread.make("test", "c1")
const origin = { thread, messageId: "m1", userId: "u1", raw: null }

const clicked = (id: string, value?: string) =>
  ChatInteraction.ButtonClicked.make({ id, ...origin, ...(value === undefined ? {} : { value }) })

const invoked = (id: string, text = "") =>
  ChatInteraction.CommandInvoked.make({ id, text, thread, userId: "u1", raw: { id: "i1" } })

const handlerWith = (options: {
  readonly click?: Effect.Effect<ChatInteraction.ClickReply>
  readonly submit?: Effect.Effect<ChatInteraction.SubmitReply>
  readonly command?: (command: ChatInteraction.CommandInvoked) => ChatInteraction.CommandReply
  readonly refused?: (error: ChatError.ChatError) => Effect.Effect<void>
}) =>
  ChatInteraction.Handler.of({
    click: () => options.click ?? Effect.succeed(ChatInteraction.ack),
    submit: () => options.submit ?? Effect.succeed(ChatInteraction.close),
    command: (command) => Effect.succeed(options.command?.(command) ?? ChatInteraction.ack),
    refused: (_, error) => options.refused?.(error) ?? Effect.void
  })

describe("ChatInteraction", () => {
  it("encodes a value by its schema: a string-only schema as it is, anything else as JSON", () => {
    const StringOrNumber = Schema.Union([Schema.String, Schema.Number])
    assert.strictEqual(ChatInteraction.encodeValue(Schema.String, "v1.4.2"), "v1.4.2")
    assert.deepStrictEqual(ChatInteraction.decodeValue(Schema.String, "\"quoted\""), Option.some("\"quoted\""))
    assert.strictEqual(ChatInteraction.encodeValue(StringOrNumber, "123"), "\"123\"")
    assert.deepStrictEqual(ChatInteraction.decodeValue(StringOrNumber, "123"), Option.some(123))
  })

  it("modal.open builds the elements in field order, with encoded metadata and options", () => {
    const Reason = ChatInteraction.modal("reason", {
      title: "Why",
      metadata: Deploy,
      fields: {
        intro: ChatInteraction.text("Tell us."),
        reason: ChatInteraction.textInput({ label: "Reason", multiline: true, maxLength: 200 }),
        env: ChatInteraction.selectInput({ label: "Env", value: Schema.Number, optional: true })
      }
    })
    const opened = Reason.open({
      metadata: { version: "v1" },
      options: { env: [{ label: "Prod", value: 1 }] },
      initial: { env: 1 }
    })
    assert.deepStrictEqual(opened.modal, {
      _tag: "Modal",
      id: "reason",
      title: "Why",
      metadata: "{\"version\":\"v1\"}",
      elements: [
        { _tag: "Text", text: "Tell us." },
        { _tag: "TextInput", id: "reason", label: "Reason", multiline: true, maxLength: 200 },
        {
          _tag: "SelectInput",
          id: "env",
          label: "Env",
          options: [{ label: "Prod", value: "1" }],
          initial: "1",
          optional: true
        }
      ]
    })
  })

  describe("layer and groups", () => {
    const Approve = ChatInteraction.button("approve", { label: "Approve", value: Deploy })
    const Reason = ChatInteraction.modal("reason", {
      title: "Why",
      metadata: Deploy,
      fields: {
        reason: ChatInteraction.textInput({ label: "Reason" }),
        severity: ChatInteraction.choice({ label: "Severity", options: [{ label: "Low", value: "low" }] }),
        note: ChatInteraction.textInput({ label: "Note", optional: true })
      }
    })
    const Ship = ChatInteraction.command("ship", {
      description: "Ship a version",
      argument: { name: "version", description: "The version" }
    })
    const seen: Array<unknown> = []
    const unhandled: Array<string> = []
    const Interactions = ChatInteraction.group(Approve).add(Reason, Ship).toLayer({
      ship: (command) => Effect.succeed(ChatInteraction.respond({ markdown: "Shipping " + command.text })),
      approve: (click) =>
        Effect.sync(() => seen.push(click.value)).pipe(Effect.as(Reason.open({ metadata: click.value }))),
      reason: (submit) =>
        Effect.sync(() => {
          seen.push({ metadata: submit.metadata, values: submit.values })
          return submit.values.reason.length < 3 ? ChatInteraction.errors({ reason: "Longer." }) : ChatInteraction.close
        })
    }).pipe(Layer.provideMerge(ChatInteraction.layer({
      unhandled: (event, why) => Effect.sync(() => void unhandled.push(event.id + ":" + why.reason))
    })))

    it.effect("routes a click and a submit to the typed handlers", () =>
      Effect.gen(function*() {
        seen.length = 0
        const handler = yield* ChatInteraction.Handler
        const reply = yield* handler.click(clicked("approve", Approve.of({ version: "v1" }).value))
        assert.strictEqual(reply._tag, "OpenModal")
        const submitted = ChatInteraction.ModalSubmitted.make({
          id: "reason",
          metadata: (reply as ChatInteraction.OpenModal).modal.metadata!,
          values: { reason: "ok", severity: "low" },
          ...origin
        })
        assert.deepStrictEqual(yield* handler.submit(submitted), ChatInteraction.errors({ reason: "Longer." }))
        assert.deepStrictEqual(seen, [
          { version: "v1" },
          { metadata: { version: "v1" }, values: { reason: "ok", severity: "low", note: undefined } }
        ])
      }).pipe(Effect.provide(Interactions)))

    it.effect("routes a command to its handler, and answers an unknown one Ack", () =>
      Effect.gen(function*() {
        unhandled.length = 0
        const handler = yield* ChatInteraction.Handler
        assert.deepStrictEqual(yield* handler.command(invoked("ship", "v1")), {
          _tag: "Respond",
          markdown: "Shipping v1",
          visibility: "ephemeral"
        })
        assert.deepStrictEqual(yield* handler.command(invoked("nope")), ChatInteraction.ack)
        // A command and a button share one id space: a command named like a button is not routed to it.
        assert.deepStrictEqual(yield* handler.command(invoked("approve")), ChatInteraction.ack)
        assert.deepStrictEqual(unhandled, ["nope:UnknownId", "approve:UnknownId"])
      }).pipe(Effect.provide(Interactions)))

    it.effect("answers an unknown id or a value that no longer decodes without a handler", () =>
      Effect.gen(function*() {
        seen.length = 0
        unhandled.length = 0
        const handler = yield* ChatInteraction.Handler
        assert.deepStrictEqual(yield* handler.click(clicked("nope")), ChatInteraction.ack)
        assert.deepStrictEqual(yield* handler.click(clicked("approve", "{")), ChatInteraction.ack)
        assert.deepStrictEqual(yield* handler.click(clicked("reason")), ChatInteraction.ack)
        const badChoice = ChatInteraction.ModalSubmitted.make({
          id: "reason",
          metadata: "{\"version\":\"v1\"}",
          values: { reason: "long enough", severity: "high" },
          ...origin
        })
        assert.deepStrictEqual(yield* handler.submit(badChoice), ChatInteraction.close)
        assert.deepStrictEqual(seen, [])
        assert.deepStrictEqual(unhandled, [
          "nope:UnknownId",
          "approve:InvalidValue",
          "reason:UnknownId",
          "reason:InvalidValue"
        ])
      }).pipe(Effect.provide(Interactions)))

    it.effect("dies on an id registered twice", () =>
      Effect.gen(function*() {
        const twice = ChatInteraction.group(Approve).toLayer({ approve: () => Effect.succeed(ChatInteraction.ack) })
        const exit = yield* Effect.exit(Layer.build(twice.pipe(Layer.provideMerge(Interactions))))
        assert.isTrue(exit._tag === "Failure")
      }).pipe(Effect.scoped))
  })

  describe("handle", () => {
    const deadline = Duration.seconds(3)

    it.effect("interrupts the handler when cancelled during startup", () =>
      Effect.gen(function*() {
        const release = yield* Deferred.make<ChatInteraction.ClickReply>()
        yield* Effect.gen(function*() {
          // Cancel at successive scheduler yields, including between fork and cleanup registration.
          for (let budget = 1; budget <= 40; budget++) {
            let started = false
            let stopped = false
            const handler = handlerWith({
              click: Effect.acquireUseRelease(
                Effect.sync(() => {
                  started = true
                }),
                () => Deferred.await(release),
                () =>
                  Effect.sync(() => {
                    stopped = true
                  })
              )
            })
            const fiber = yield* ChatInteraction.handle(clicked("a"), deadline).pipe(
              Effect.provideService(ChatInteraction.Handler, handler),
              Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
              Effect.forkChild({ startImmediately: true })
            )
            yield* Fiber.interrupt(fiber)
            yield* TestClock.adjust("1 millis")
            assert.isFalse(started && !stopped, `MaxOpsBeforeYield ${budget}`)
          }
        }).pipe(Effect.ensuring(Deferred.succeed(release, ChatInteraction.ack)))
      }))

    it.effect("gives Late for a late click, and refuses its modal with interaction_expired", () =>
      Effect.gen(function*() {
        const refused = yield* Deferred.make<ChatError.ChatError>()
        const opened = ChatInteraction.modal("m", { title: "M", fields: {} }).open()
        const handler = handlerWith({
          click: Effect.as(Effect.sleep("5 seconds"), opened),
          refused: (error) => Deferred.succeed(refused, error).pipe(Effect.asVoid)
        })
        const fiber = yield* ChatInteraction.handle(clicked("a"), deadline).pipe(
          Effect.provideService(ChatInteraction.Handler, handler),
          Effect.forkChild
        )
        yield* TestClock.adjust("3 seconds")
        const reply = yield* Fiber.join(fiber)
        assert.strictEqual(reply._tag, "Late")
        // The click's handler is still running, and its modal can no longer open.
        yield* TestClock.adjust("2 seconds")
        const error = yield* Deferred.await(refused)
        assert.strictEqual(error.op, "openModal")
        assert.strictEqual(error.platform, "test")
        assert.strictEqual(error.reason._tag, "NotFound")
        assert.strictEqual(error.reason.detail, ChatError.interactionExpired)
      }))

    it.effect("gives Late at the deadline without waiting for a late submit's cleanup", () =>
      Effect.gen(function*() {
        const cleaned = yield* Deferred.make<void>()
        const handler = handlerWith({
          submit: Effect.never.pipe(
            Effect.onInterrupt(() => Effect.andThen(Effect.sleep("5 seconds"), Deferred.succeed(cleaned, undefined)))
          )
        })
        const submitted = ChatInteraction.ModalSubmitted.make({ id: "m", values: {}, ...origin })
        const fiber = yield* ChatInteraction.handle(submitted, deadline).pipe(
          Effect.provideService(ChatInteraction.Handler, handler),
          Effect.forkChild
        )
        yield* TestClock.adjust("3 seconds")
        const exit = fiber.pollUnsafe()
        assert.isDefined(exit)
        assert.isTrue(Exit.isSuccess(exit!) && exit.value._tag === "Late")
        // The interrupt was requested, and the cleanup still runs to its end.
        assert.isFalse(yield* Deferred.isDone(cleaned))
        yield* TestClock.adjust("5 seconds")
        yield* Deferred.await(cleaned)
      }))
  })

  describe("ChatTest.interact", () => {
    it.effect("follows up a deferral once, inside followUpAge", () =>
      Effect.gen(function*() {
        const test = yield* ChatTest.ChatTest
        const chat = yield* Chat.Chat
        const channel = yield* test.makeThread()
        const handler = handlerWith({ command: (command) => ChatInteraction.defer(command) })
        const interact = (command: ChatInteraction.CommandInvoked) =>
          Effect.provideService(test.interact(command), ChatInteraction.Handler, handler)
        const first = yield* interact(yield* test.command(channel, "summarize"))
        yield* chat.followUp(first as ChatInteraction.Defer, { markdown: "Done" })
        const twice = yield* Effect.flip(chat.followUp(first as ChatInteraction.Defer, { markdown: "Again" }))
        assert.strictEqual(twice.reason.detail, ChatError.interactionExpired)
        const second = yield* interact(yield* test.command(channel, "summarize"))
        yield* TestClock.adjust("15 minutes")
        const expired = yield* Effect.flip(chat.followUp(second as ChatInteraction.Defer, { markdown: "Late" }))
        assert.strictEqual(expired.reason._tag, "NotFound")
        assert.strictEqual(expired.reason.detail, ChatError.interactionExpired)
      }).pipe(Effect.provide(ChatTest.layer())))

    it.effect("refuses a private answer without ephemeral, and sends nothing", () =>
      Effect.gen(function*() {
        const test = yield* ChatTest.ChatTest
        const channel = yield* test.makeThread()
        const refused: Array<ChatError.ChatError> = []
        const handler = handlerWith({
          command: (command) =>
            command.text === "defer" ? ChatInteraction.defer(command) : ChatInteraction.respond({ markdown: "Secret" }),
          refused: (error) => Effect.sync(() => void refused.push(error))
        })
        for (const text of ["respond", "defer"]) {
          yield* Effect.provideService(
            test.interact(yield* test.command(channel, "secret", { text })),
            ChatInteraction.Handler,
            handler
          )
        }
        assert.deepStrictEqual(
          refused.map((error) => error.reason._tag === "Unsupported" && error.reason.capability),
          ["ephemeral", "ephemeral"]
        )
        assert.deepStrictEqual((yield* test.calls).map((call) => [call.op, call.outcome]), [["respond", "Unsupported"]])
      }).pipe(Effect.provide(ChatTest.layer({
        capabilities: ChatError.Capability.literals.filter((capability) => capability !== "ephemeral")
      }))))
  })
})

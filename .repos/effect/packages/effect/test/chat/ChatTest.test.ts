import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option } from "effect"
import {
  Chat,
  ChatAdapter,
  ChatError,
  ChatHandler,
  ChatInteraction,
  ChatMessage,
  ChatTest,
  ChatThread
} from "effect/chat"

const kinds = { "@": "user", "@&": "role", "#": "channel", "!": "broadcast" } as const

const parseMention: ChatTest.ParseMention = (slice) => {
  const match = /^<(@&|@|#|!)([^<>\s]+)>$/.exec(slice)
  return match === null ? Option.none() : Option.some({ kind: kinds[match[1] as keyof typeof kinds], id: match[2] })
}

/** The conformance click hook, over the fake's own entry. */
const interactionsFor = (test: ChatTest.ChatTest["Service"]): ChatTest.Interactions => {
  let open: {
    readonly from: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged | ChatInteraction.CommandInvoked
    readonly opened: ChatInteraction.OpenModal
  } | undefined
  const deliver = Effect.fnUntraced(function*(
    from: ChatInteraction.ButtonClicked | ChatInteraction.SelectChanged | ChatInteraction.CommandInvoked
  ) {
    const handler = yield* ChatInteraction.Handler
    let refused = false
    const reply = yield* test.interact(from as ChatInteraction.CommandInvoked).pipe(
      Effect.provideService(ChatInteraction.Handler, {
        ...handler,
        refused: (event, error) =>
          Effect.andThen(Effect.sync(() => void (refused = true)), handler.refused(event, error))
      })
    )
    open = reply._tag === "OpenModal" && !refused ? { from, opened: reply } : undefined
  })
  return {
    click: (messageId, id, options) => Effect.flatMap(test.click(messageId, id, options), deliver),
    command: (thread, id, options) => Effect.flatMap(test.command(thread, id, options), deliver),
    submit: Effect.fnUntraced(function*(values) {
      if (open === undefined) return
      const reply = yield* test.interact(yield* test.submit(open.from, open.opened, values))
      if (reply._tag !== "Errors") open = undefined
    })
  }
}

const rulesFor = (test: ChatTest.ChatTest["Service"], thread: ChatThread.ChatThread) =>
  ChatTest.conformance({
    platform: test.platform,
    thread,
    userPosts: (thread, text) => test.userPosts(thread, { text }),
    parseMention,
    refuseFiles: test.refuseFiles,
    failNext: test.failNext,
    interactions: interactionsFor(test)
  })

const suite = Effect.gen(function*() {
  const test = yield* ChatTest.ChatTest
  return rulesFor(test, yield* test.makeThread())
})

const ruleNames = Object.keys(ChatTest.conformance({
  platform: "test",
  thread: ChatThread.make("test", "c0"),
  userPosts: () => Effect.die("unused"),
  parseMention,
  refuseFiles: () => Effect.void,
  failNext: () => Effect.void,
  interactions: { click: () => Effect.void, submit: () => Effect.void, command: () => Effect.void }
}))

const capabilities = ChatError.Capability.literals

const runRule = (rule: string, options?: Parameters<typeof ChatTest.layer>[0]) =>
  Effect.flatMap(suite, (rules) => rules[rule]).pipe(Effect.provide(ChatTest.layer(options)))

describe("ChatTest", () => {
  it.effect("allows a post when the fault count is zero", () =>
    Effect.gen(function*() {
      const test = yield* ChatTest.ChatTest
      const chat = yield* Chat.Chat
      const thread = yield* test.makeThread()
      yield* test.failNext("post", new ChatError.Forbidden({ detail: "zero-count fault" }), { times: 0 })
      yield* chat.post(thread, { markdown: "hello" })
    }).pipe(Effect.provide(ChatTest.layer())))

  describe("conformance with every capability", () => {
    for (const rule of ruleNames) {
      it.live(rule, () => runRule(rule))
    }
  })

  // With a capability off, a gated rule only probes it, as unsupported/{capability} does.
  describe("conformance without any capability", () => {
    for (const rule of ruleNames.filter((name) => name.startsWith("unsupported/"))) {
      it.live(rule, () => runRule(rule, { capabilities: [] }))
    }
  })

  // Paths that all-on and all-off miss: a probe gated on another capability, and a modal opened from a select.
  for (
    const [rule, off] of [
      ["modal/origin", "buttons"],
      ["unsupported/modals", "modals"],
      ["modal/errorsKeepOpen", "modalErrors"],
      ["unsupported/ephemeral", "ephemeral"]
    ] as const
  ) {
    it.live(`conformance ${rule} without ${off}`, () =>
      runRule(rule, { capabilities: capabilities.filter((c) => c !== off) }))
  }

  it("lists the hook rules only with their hooks", () => {
    const withoutHooks = Object.keys(ChatTest.conformance({
      platform: "test",
      thread: ChatThread.make("test", "c0"),
      userPosts: () => Effect.die("unused"),
      parseMention
    }))
    assert.include(withoutHooks, "unsupported/buttons")
    for (const name of ["post/refusedFile", "actions/valueRoundTrips", "command/arrives", "retries/retrySafe"]) {
      assert.notInclude(withoutHooks, name)
      assert.include(ruleNames, name)
    }
  })

  it.effect("fails unsupported/{capability} for a descriptor that leaves out a working op", () =>
    Effect.gen(function*() {
      const registry = yield* ChatAdapter.Registry
      const adapter = yield* registry.get("test")
      const listed = new Set(adapter.descriptor.capabilities)
      listed.delete("edit")
      yield* registry.register({ ...adapter, descriptor: { ...adapter.descriptor, capabilities: listed } })
      const failure = yield* Effect.flip(Effect.flatMap(suite, (rules) => rules["unsupported/edit"]))
      assert.strictEqual(failure.rule, "unsupported/edit")
      assert.strictEqual(failure.actual, "success")
    }).pipe(Effect.provide(ChatTest.layer())))

  it.effect("fails a rule whose listed capability fails with Unsupported", () =>
    Effect.gen(function*() {
      const registry = yield* ChatAdapter.Registry
      const adapter = yield* registry.get("test")
      yield* registry.register({
        ...adapter,
        edit: () =>
          Effect.fail(
            new ChatError.ChatError({
              platform: "test",
              op: "edit",
              reason: new ChatError.Unsupported({ capability: "edit" })
            })
          )
      })
      const failure = yield* Effect.flip(Effect.flatMap(suite, (rules) => rules["edit/keepsId"]))
      assert.strictEqual(failure.actual, "Unsupported(edit) for a listed capability")
    }).pipe(Effect.provide(ChatTest.layer())))

  it.effect("post/refusedFile cleans up a refused write that landed", () =>
    Effect.gen(function*() {
      const test = yield* ChatTest.ChatTest
      const thread = yield* test.makeThread()
      const rules = ChatTest.conformance({
        platform: test.platform,
        thread,
        parseMention,
        userPosts: (thread, text) => test.userPosts(thread, { text }),
        refuseFiles: () =>
          test.failNext("post", new ChatError.Forbidden({ detail: ChatError.fileRefused }), { landed: true })
      })
      const error = yield* Effect.flip(rules["post/refusedFile"])
      assert.strictEqual(error.expected, "no new message")
      assert.deepStrictEqual(yield* test.messages(thread), [])
    }).pipe(Effect.provide(ChatTest.layer())))

  it.live("deletes every bot message the suite posts", () =>
    Effect.gen(function*() {
      const test = yield* ChatTest.ChatTest
      const thread = yield* test.makeThread()
      yield* Effect.forEach(Object.values(rulesFor(test, thread)), (rule) => rule, { discard: true })
      const left = (yield* test.messages(thread)).filter((message) => message.author.isSelf)
      assert.deepStrictEqual(left.map((message) => message.text), [])
    }).pipe(Effect.provide(ChatTest.layer())))

  it.effect("checkInteraction rejects an empty messageId", () =>
    Effect.gen(function*() {
      const submitted = ChatInteraction.ModalSubmitted.make({
        id: "ask",
        values: {},
        thread: ChatThread.make("test", "c1"),
        messageId: "",
        userId: "u",
        raw: null
      })
      const failure = yield* Effect.flip(ChatTest.checkInteraction(submitted, { platform: "test" }))
      assert.strictEqual(failure.actual, "an empty messageId")
    }))

  it.effect("repliesToSelf is true only for a reply to the bot's message; checkMessage rejects bad replyTo and mentions", () =>
    Effect.gen(function*() {
      const test = yield* ChatTest.ChatTest
      const chat = yield* Chat.Chat
      const thread = yield* test.makeThread()
      const message = (event: { readonly _tag: string; readonly message?: ChatMessage.ChatMessage }) => {
        assert(event._tag === "MessageCreated" && event.message !== undefined)
        return event.message
      }
      const own = yield* chat.post(thread, { markdown: "from the bot" })
      const plain = message(yield* test.userPosts(thread, { text: "no reply" }))
      const toBot = message(yield* test.userPosts(thread, { text: "to the bot", replyTo: { messageId: own.id } }))
      const toUser = message(yield* test.userPosts(thread, { text: "to a person", replyTo: { messageId: plain.id } }))
      assert.deepStrictEqual([plain, toBot, toUser].map(ChatMessage.repliesToSelf), [false, true, false])
      assert.isFalse(ChatMessage.mentionsSelf(toBot))
      // checkMessage rejects an author without isSelf, and isSelf without an author.
      for (const replyTo of [{ messageId: own.id, authorId: test.selfId }, { messageId: own.id, isSelf: true }]) {
        const exit = yield* Effect.exit(
          ChatTest.checkMessage({ ...toBot, replyTo }, { platform: "test", parseMention })
        )
        assert.isTrue(Exit.isFailure(exit))
      }
      // It also rejects a mention whose slice is not its token.
      const mentioning = message(yield* test.userPosts(thread, { text: "hi", mentionsSelf: true }))
      yield* ChatTest.checkMessage(mentioning, { platform: "test", parseMention })
      const shifted = {
        ...mentioning,
        mentions: mentioning.mentions.map((mention) => ({ ...mention, start: mention.start + 1 }))
      }
      const exit = yield* Effect.exit(ChatTest.checkMessage(shifted, { platform: "test", parseMention }))
      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.provide(ChatTest.layer())))

  it.effect("ChatHandler.layer drops the bot's own messages unless deliverSelf", () =>
    Effect.gen(function*() {
      const test = yield* ChatTest.ChatTest
      const thread = yield* test.makeThread()
      const own = yield* test.userPosts(thread, { text: "own" })
      const self = own._tag === "MessageCreated"
        ? { ...own, message: { ...own.message, author: { ...own.message.author, isSelf: true } } }
        : own
      const received: Array<string> = []
      const handler = ChatHandler.layer((event) => Effect.sync(() => void received.push(event._tag)))
      yield* test.deliver(self).pipe(Effect.provide(handler))
      yield* test.deliver(own).pipe(Effect.provide(handler))
      yield* test.deliver(self).pipe(Effect.provide(ChatHandler.layer(
        (event) => Effect.sync(() => void received.push("self " + event._tag)),
        { deliverSelf: true }
      )))
      assert.deepStrictEqual(received, ["MessageCreated", "self MessageCreated"])
    }).pipe(Effect.provide(ChatTest.layer())))
})

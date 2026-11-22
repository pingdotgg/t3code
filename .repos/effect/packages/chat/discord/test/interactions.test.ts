import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { assert, describe, it } from "@effect/vitest"
import * as DiscordConfig from "dfx/DiscordConfig"
import { DiscordRESTLive } from "dfx/DiscordREST"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import * as Chat from "effect/chat/Chat"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as TestClock from "effect/testing/TestClock"
import { botUserId, discordLayer, type Fake, guild, makeFake, recordedCommands, scratch, tim } from "./utils.ts"

const message = { id: "1570700000000000001", channel_id: scratch }

const click = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "1570700000000000100",
  application_id: botUserId,
  type: 3,
  token: "token",
  version: 1,
  guild_id: guild,
  channel_id: scratch,
  member: { user: { id: tim } },
  message,
  data,
  ...extra
})

const submit = (components: ReadonlyArray<unknown>) => click({ custom_id: "form", components }, { type: 5 })

const slash = (name: string, options?: ReadonlyArray<unknown>, data: Record<string, unknown> = {}) => ({
  ...recordedCommands.commands.private,
  id: "1570700000000000100",
  token: "token",
  data: { id: "1570700000000000900", name, type: 1, ...(options === undefined ? {} : { options }), ...data }
})

const some = (raw: unknown) => Option.getOrThrow(DiscordChat.normalizeInteraction(raw))

describe("normalizeInteraction", () => {
  it("a button splits its custom_id into id and value at the first join, from a member or a direct's user", () => {
    const { member: _, ...direct } = click({ custom_id: "go\u241Fa\u241Fb", component_type: 2 })
    for (const raw of [click({ custom_id: "go\u241Fa\u241Fb", component_type: 2 }), { ...direct, user: { id: tim } }]) {
      const clicked = some(raw)
      assert.deepStrictEqual(
        clicked,
        ChatInteraction.ButtonClicked.make({
          id: "go",
          value: "a\u241Fb",
          thread: DiscordChat.thread(scratch),
          messageId: message.id,
          userId: tim,
          raw: clicked.raw
        })
      )
    }
  })

  it("a submit reads each input, a Label's or an action row's, and leaves an empty one out", () => {
    const submitted = some(submit([
      { type: 10 },
      { type: 18, component: { type: 4, custom_id: "name", value: "Tim" } },
      { type: 18, component: { type: 4, custom_id: "note", value: "" } },
      { type: 18, component: { type: 3, custom_id: "size", values: ["l"] } },
      { type: 18, component: { type: 3, custom_id: "none", values: [] } },
      { type: 1, components: [{ type: 4, custom_id: "old", value: "row" }] }
    ]))
    assert(submitted._tag === "ModalSubmitted")
    assert.deepStrictEqual(submitted.values, { name: "Tim", size: "l", old: "row" })
  })

  it("a submit keeps an input whose id is __proto__ as its own field", () => {
    const submitted = some(submit([
      { type: 18, component: { type: 4, custom_id: "__proto__", value: "answered" } },
      { type: 18, component: { type: 4, custom_id: "name", value: "Tim" } }
    ]))
    assert(submitted._tag === "ModalSubmitted")
    assert.isTrue(Object.hasOwn(submitted.values, "__proto__"))
    assert.deepStrictEqual(Object.entries(submitted.values), [["__proto__", "answered"], ["name", "Tim"]])
  })

  it("anything not from an element the adapter built, or a command it can't express, is None", () => {
    const { message: _, ...noMessage } = click({ custom_id: "go", component_type: 2 })
    for (
      const raw of [
        // A user command, and a slash command with an integer option.
        slash("profile", undefined, { type: 2 }),
        slash("roll", [{ type: 4, name: "sides", value: 6 }]),
        // Autocomplete for a command.
        { ...slash("deploy", [{ type: 3, name: "version", value: "v", focused: true }]), type: 4 },
        // A user select, and a click with no message.
        click({ custom_id: "users", component_type: 5, values: [tim] }),
        noMessage
      ]
    ) {
      assert.isTrue(Option.isNone(DiscordChat.normalizeInteraction(raw)))
    }
  })
})

describe("interaction", () => {
  const handler = (options: {
    readonly delay?: Duration.Duration
    readonly command?: ChatInteraction.CommandReply
  }) =>
    ChatInteraction.Handler.of({
      click: () => Effect.as(Effect.sleep(options.delay ?? Duration.zero), ChatInteraction.ack),
      submit: () => Effect.succeed(ChatInteraction.close),
      command: () => Effect.succeed(options.command ?? ChatInteraction.ack),
      refused: (_, error) => Effect.die(error)
    })

  const deliver = (
    fake: Fake,
    raw: unknown,
    handler: ChatInteraction.Handler["Service"],
    options?: { readonly deadline?: Duration.Duration }
  ) =>
    Effect.flatMap(DiscordChat.DiscordChat, (discord) => discord.interaction(raw, options)).pipe(
      Effect.provideService(ChatInteraction.Handler, handler),
      Effect.provide(discordLayer(fake))
    )

  const answering = () => makeFake({ createInteractionResponse: () => Effect.succeed(null) })
  const payloads = (fake: Fake) => fake.called("createInteractionResponse").map(([, , options]) => options.payload)

  it.effect("sends nothing when the handler misses its deadline, 2 seconds by default", () =>
    Effect.gen(function*() {
      const fake = answering()
      const late = handler({ delay: Duration.seconds(3) })
      const fiber = yield* Effect.forkChild(deliver(fake, click({ custom_id: "go", component_type: 2 }), late))
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(payloads(fake), [])
      const longer = yield* Effect.forkChild(
        deliver(fake, click({ custom_id: "go", component_type: 2 }), late, { deadline: Duration.seconds(5) })
      )
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(longer)
      assert.deepStrictEqual(payloads(fake), [{ type: 6 }])
    }))

  it.effect("withPostOptions does not reach a command's answer, which notifies nobody", () =>
    Effect.gen(function*() {
      const fake = answering()
      yield* DiscordChat.withPostOptions(
        deliver(
          fake,
          slash("summarize"),
          handler({
            command: ChatInteraction.respond({ markdown: "Hi", visibility: "public" })
          })
        ),
        { suppressEmbeds: false, notify: { everyone: true } }
      )
      assert.deepStrictEqual(payloads(fake), [{
        type: 4,
        data: { content: "Hi", allowed_mentions: { parse: [], replied_user: false, roles: [], users: [] }, flags: 4 }
      }])
    }))
})

it("commandRequests gives a CHAT_INPUT command per definition, with one STRING option for an argument", () => {
  const group = ChatInteraction.group(
    ChatInteraction.command("summarize", { description: "Summarize this thread" }),
    ChatInteraction.button("go", { label: "Go" }),
    ChatInteraction.command("note", { description: "Add a note", argument: { name: "text", description: "The note" } })
  )
  assert.deepStrictEqual(DiscordChat.commandRequests(group), [
    { type: 1, name: "summarize", description: "Summarize this thread" },
    {
      type: 1,
      name: "note",
      description: "Add a note",
      options: [{ type: 3, name: "text", description: "The note", required: false }]
    }
  ])
})

it.effect("followUp sends one HTTP request through dfx's layers on a 429 just before 15 minutes, and fails RateLimited", () =>
  Effect.gen(function*() {
    const deferred = ChatInteraction.defer(some(slash("summarize")) as ChatInteraction.CommandInvoked, {
      visibility: "public"
    })
    const issued = Number((BigInt("1570700000000000100") >> 22n) + 1420070400000n)
    const attempts: Array<{ readonly url: string; readonly authorized: boolean; readonly at: number }> = []
    const http = HttpClient.make((request) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        attempts.push({ url: request.url, authorized: "authorization" in request.headers, at: at - issued })
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ message: "You are being rate limited.", retry_after: 0.6, global: false }, {
            status: 429,
            headers: { "retry-after": "0.6" }
          })
        )
      })
    )
    // dfx's own REST layers, which wait out a 429 and send again, over an HTTP client that counts.
    const layer = DiscordChat.layer.pipe(
      Layer.provideMerge(Chat.layer),
      Layer.provide(DiscordRESTLive),
      Layer.provide([
        DiscordConfig.layer({ token: Redacted.make("bot-token"), rest: { baseUrl: "https://discord.test/api" } }),
        MemoryRateLimitStoreLive,
        Layer.succeed(HttpClient.HttpClient, http)
      ])
    )
    yield* TestClock.setTime(issued + Duration.toMillis(Duration.minutes(15)) - 300)
    const fiber = yield* Effect.forkChild(Effect.flip(
      Effect.flatMap(Chat.Chat, (chat) => chat.followUp(deferred, { markdown: "Done" })).pipe(Effect.provide(layer))
    ))
    yield* TestClock.adjust(Duration.seconds(10))
    const error = yield* Fiber.join(fiber)
    assert.deepStrictEqual([error.op, error.reason._tag], ["followUp", "RateLimited"])
    assert.deepStrictEqual(attempts, [{
      url: `https://discord.test/api/webhooks/${botUserId}/token/messages/@original`,
      authorized: false,
      at: Duration.toMillis(Duration.minutes(15)) - 300
    }])
  }))

/**
 * Slash commands against what Slack sent and what it took, recorded on
 * janitor2 in test-janitor during EFF-3802: `fixtures/recorded/commands.json`.
 * Slack's signature on these requests was not verified, see the fixture's
 * provenance.
 */
import * as SlackChat from "@effect/chat-slack/SlackChat"
import { assert, describe, it } from "@effect/vitest"
import * as Chat from "effect/chat/Chat"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { authTest, fixture, makeFake, slackLayer, team } from "./utils.ts"

const recorded = fixture("commands")
const channel = "C0CJMJ5UMUY"

// The definitions the capture ran, from eff-3802-capture.ts.
const actions = [
  ChatInteraction.button("cap-ack", { label: "Ack" }).of(),
  ChatInteraction.button("cap-open", { label: "Open modal", style: "primary" }).of()
]

/** The capture's handler, by the command's text. */
const reply = (command: ChatInteraction.CommandInvoked): ChatInteraction.CommandReply => {
  switch (command.text) {
    case "public":
      return ChatInteraction.respond({
        markdown: "**Public answer** with _Markdown_ and buttons",
        actions,
        visibility: "public"
      })
    case "mention":
      return ChatInteraction.respond({ markdown: "Private answer mentioning <@" + command.userId + ">" })
    case "defer":
      return ChatInteraction.defer(command)
    default:
      return ChatInteraction.respond({
        markdown: "**Private answer** with _Markdown_, a list:\n\n- one\n- two\n\nand buttons",
        actions
      })
  }
}

const handler = Layer.succeed(ChatInteraction.Handler, {
  click: () => Effect.die("unused"),
  submit: () => Effect.die("unused"),
  command: (command) => Effect.succeed(reply(command)),
  refused: (_, error) => Effect.die(error)
})

const normalize = (payload: unknown) => Option.getOrThrow(SlackChat.normalizeInteraction(payload, { teamId: team }))

const interact = (fake: ReturnType<typeof makeFake>, payload: unknown) =>
  Effect.flatMap(SlackChat.SlackChat, (slack) => slack.interaction(payload, { deadline: Duration.seconds(1) })).pipe(
    Effect.provide(handler),
    Effect.provide(slackLayer(fake))
  )

describe("recorded slash commands", () => {
  it.live("answers each command with the body Slack rendered", () =>
    Effect.gen(function*() {
      const fake = makeFake({ "auth.test": authTest })
      for (const what of ["private", "public", "mention", "defer"]) {
        const answer = yield* interact(fake, recorded.commands[what])
        assert.deepStrictEqual(answer, recorded.answers[what] ?? undefined, what)
      }
    }))

  it("takes a click on a private answer, which has no message, from its container", () => {
    const payload = recorded.clicks.privateAnswer
    assert.isFalse("message" in payload)
    const click = normalize(payload)
    assert.strictEqual(click._tag, "ButtonClicked")
    // The id names where the click came from. chat.update on it answered
    // message_not_found: a private answer is not a message Chat can reach.
    assert.deepStrictEqual([click.id, (click as ChatInteraction.ButtonClicked).messageId, click.thread.id], [
      "cap-ack",
      payload.container.message_ts,
      `${team}/${channel}`
    ])
  })

  it.effect("follows up with the body Slack rendered, and maps a spent and an expired response_url", () =>
    Effect.gen(function*() {
      const command = normalize(recorded.commands.defer) as ChatInteraction.CommandInvoked
      const deferred = ChatInteraction.defer(command)
      const followUp = (answer: { readonly status: number; readonly contentType: string; readonly body: string }) => {
        const fake = makeFake({
          "auth.test": authTest,
          "response_url": { status: answer.status, headers: { "content-type": answer.contentType }, body: answer.body }
        })
        const sent = Effect.flatMap(
          Chat.Chat,
          (chat) => chat.followUp(deferred, { markdown: "**Deferred answer** to defer, with buttons", actions })
        ).pipe(
          Effect.provide(slackLayer(fake))
        )
        return { fake, sent }
      }

      const ok = followUp(recorded.responseUrl.followUp.response)
      yield* ok.sent
      const [{ params: { url, ...body } }] = ok.fake.called("response_url")
      assert.strictEqual(url, new URL((command.raw as any).response_url).href)
      assert.deepStrictEqual(body, recorded.responseUrl.followUp.request)

      for (const answer of [recorded.responseUrl.spent.response, recorded.responseUrl.expired.responses[0]]) {
        const error = yield* Effect.flip(followUp(answer).sent)
        assert.deepStrictEqual([error.op, error.reason._tag, error.reason.detail, (error.reason as any).cause], [
          "followUp",
          "NotFound",
          "interaction_expired",
          answer.body
        ])
      }
    }))
})

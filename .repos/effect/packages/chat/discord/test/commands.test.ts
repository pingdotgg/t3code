/**
 * Slash commands against what Discord sent and what it took, recorded in
 * #test of guild 840178841540362250 during EFF-3802:
 * `fixtures/recorded/commands.json`.
 */
import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { assert, describe, it } from "@effect/vitest"
import * as Chat from "effect/chat/Chat"
import * as ChatInteraction from "effect/chat/ChatInteraction"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import { botUserId, discordLayer, errorResponse, type Fake, makeFake, recordedCommands as recorded } from "./utils.ts"

// The definitions the capture ran, from eff-3802-capture.ts.
const actions = [
  ChatInteraction.button("cap-ack", { label: "Ack" }).of(),
  ChatInteraction.button("cap-open", { label: "Open modal", style: "primary" }).of()
]
const Modal = ChatInteraction.modal("cap-modal", {
  title: "Capture",
  submitLabel: "Send",
  fields: { note: ChatInteraction.textInput({ label: "Note (type err for a field error)" }) }
})

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
    case "modal":
      return Modal.open()
    case "defer":
      return ChatInteraction.defer(command)
    case "defer-public":
      return ChatInteraction.defer(command, { visibility: "public" })
    default:
      return ChatInteraction.respond({
        markdown: "**Private answer** with _Markdown_, a list:\n\n- one\n- two\n\nand buttons",
        actions
      })
  }
}

const handler = ChatInteraction.Handler.of({
  click: () => Effect.succeed(ChatInteraction.ack),
  submit: (submitted) =>
    Effect.succeed(
      submitted.values.note === "err"
        ? ChatInteraction.errors({ note: "That is the error you asked for" })
        : ChatInteraction.close
    ),
  command: (command) => Effect.succeed(reply(command)),
  refused: (_, error) => Effect.die(error)
})

const normalize = (payload: unknown) => Option.getOrThrow(DiscordChat.normalizeInteraction(payload))

describe("recorded slash commands", () => {
  it.effect("answers each command, and the submits of its modal, with the callback Discord took", () =>
    Effect.gen(function*() {
      const answered = [
        ...["private", "public", "mention", "modal", "defer", "deferPublic"].map((what) =>
          [what, recorded.commands[what], recorded.callbacks[what].payload] as const
        ),
        // Discord has no field errors, so the errors go out as a private message that notifies nobody.
        ["submitErrors", recorded.commandModal.submitErrors, recorded.commandModal.errorsCallback.payload] as const,
        ["submitClose", recorded.commandModal.submitClose, recorded.commandModal.closeCallback.payload] as const
      ]
      for (const [what, payload, callback] of answered) {
        const fake = makeFake({ createInteractionResponse: () => Effect.succeed(null) })
        yield* Effect.flatMap(DiscordChat.DiscordChat, (discord) => discord.interaction(payload)).pipe(
          Effect.provideService(ChatInteraction.Handler, handler),
          Effect.provide(discordLayer(fake))
        )
        assert.deepStrictEqual(
          fake.called("createInteractionResponse").map(([id, token, options]) => [id, token, options.payload]),
          [[payload.id, "<redacted>", callback]],
          what
        )
      }
    }))

  it.effect("follows up with the edit Discord took, and is interaction_expired once the token is spent", () =>
    Effect.gen(function*() {
      const payload = recorded.commands.defer
      const deferred = ChatInteraction.defer(normalize(payload) as ChatInteraction.CommandInvoked)
      const followUp = (fake: Fake) =>
        Effect.flatMap(
          Chat.Chat,
          (chat) => chat.followUp(deferred, { markdown: "**Deferred answer** to defer, with buttons", actions })
        ).pipe(Effect.provide(discordLayer(fake)))
      const issued = Number((BigInt(payload.id) >> 22n) + 1420070400000n)
      yield* TestClock.setTime(issued + 4_000)
      const edited = makeFake({ updateOriginalWebhookMessage: () => Effect.succeed(recorded.followUp.response.body) })
      yield* followUp(edited)
      assert.deepStrictEqual(
        edited.called("updateOriginalWebhookMessage").map(([applicationId, token, options]) => [
          applicationId,
          token,
          options.payload
        ]),
        [[botUserId, "<redacted>", recorded.followUp.request]]
      )

      // What Discord answered at 15.5 minutes, 401 with 50027, returned here
      // early; past 15 minutes the adapter refuses without a call.
      const spent = makeFake({
        updateOriginalWebhookMessage: () =>
          Effect.fail(errorResponse(recorded.expired.edit.status, recorded.expired.edit.body))
      })
      const mapped = yield* Effect.flip(followUp(spent))
      yield* TestClock.setTime(issued + Duration.toMillis(Duration.minutes(15)) + 30_000)
      const refused = yield* Effect.flip(followUp(spent))
      assert.deepStrictEqual([mapped, refused].map((error) => [error.op, error.reason._tag, error.reason.detail]), [
        ["followUp", "NotFound", "interaction_expired"],
        ["followUp", "NotFound", "interaction_expired"]
      ])
      assert.strictEqual(spent.called("updateOriginalWebhookMessage").length, 1)
    }))
})

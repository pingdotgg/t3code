import * as SlackChat from "@effect/chat-slack/SlackChat"
import { assert, describe, it } from "@effect/vitest"
import type * as ChatEvent from "effect/chat/ChatEvent"
import { checkMessage } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import * as fs from "node:fs"
import { botUserId, checkOptions, fixture, messageEnvelope, team } from "./utils.ts"

const context = { teamId: team, botUserId }

const read = Effect.fnUntraced(function*(message: Record<string, unknown>) {
  const events = SlackChat.normalize(messageEnvelope(message), context)
  assert.strictEqual(events.length, 1)
  const event = events[0] as ChatEvent.MessageCreated
  assert.strictEqual(event._tag, "MessageCreated")
  // Includes that each mention's span parses as its token.
  yield* checkMessage(event.message, checkOptions)
  return event.message
})

/** A message a recorded read returned, by ts. */
const recorded = (name: string, ts: string): Record<string, unknown> =>
  fixture(name).calls.flatMap((call) => call.response?.messages ?? []).find((message: any) => message.ts === ts)

const synthetic: {
  readonly cases: ReadonlyArray<{ readonly name: string; readonly markdown: string; readonly message: any }>
} = JSON.parse(fs.readFileSync(new URL("./fixtures/synthetic/own-messages.json", import.meta.url), "utf8"))

describe("the bot's own messages read back", () => {
  it.effect("give the Markdown they were posted with, from recordings", () =>
    Effect.gen(function*() {
      // The fixture posted raw markdown_text with `&lt;not a tag&gt;` typed
      // as entities. Through the adapter the same message is `<not a tag>`.
      const mentionsPost = fixture("markdown-mentions").calls[0].request.markdown_text as string
      const cases: ReadonlyArray<readonly [name: string, ts: string, markdown: string]> = [
        ["markdown-mentions", "1794509003.143939", mentionsPost.replace("&lt;not a tag&gt;", "<not a tag>")],
        // Two appends.
        ["stream", "1794509111.134189", `Streaming **part one**. Part two with <@${botUserId}>.`]
      ]
      for (const [name, ts, markdown] of cases) {
        const message = recorded(name, ts)
        const read_ = yield* read(message)
        assert.strictEqual(read_.text, markdown, name)
        // Slack's own field stays on raw.
        assert.strictEqual((read_.raw as any).text, message.text, name)
      }
      // Slack stored the markdown-mentions text with its fence on one line.
      assert.notStrictEqual(recorded("markdown-mentions", "1794509003.143939").text, mentionsPost)
    }))

  it.effect("give the Markdown they were posted with, from synthetic messages", () =>
    Effect.gen(function*() {
      for (const { markdown, message, name } of synthetic.cases) {
        assert.strictEqual((yield* read(message)).text, markdown, name)
      }
    }))

  it.effect("preserve a trailing parenthesis in a named link destination", () =>
    Effect.gen(function*() {
      const message = yield* read({
        user: botUserId,
        ts: "1794600000.000103",
        text: "draft",
        blocks: [{
          type: "rich_text",
          elements: [{
            type: "rich_text_section",
            elements: [{ type: "link", text: "draft", url: "https://example.test/drafts/closing)" }]
          }]
        }]
      })
      assert.strictEqual(message.text, "[draft](https://example.test/drafts/closing\\))")
    }))

  it.effect("someone else's message keeps Slack's text", () =>
    Effect.gen(function*() {
      const { message } = synthetic.cases.find(({ name }) => name.startsWith("Markdown characters"))!
      const { app_id: _app, bot_id: _bot, ...rest } = message
      const read_ = yield* read({ ...rest, user: "U080YLYB277" })
      assert.strictEqual(read_.text, message.text)
    }))
})

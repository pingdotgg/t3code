/**
 * The conformance rules against the adapter over a stubbed Web API that keeps
 * what was posted. Clicks, submits and commands are built from the posted
 * blocks and the opened views and go through `SlackChat.interaction`.
 */
import * as SlackChat from "@effect/chat-slack/SlackChat"
import { describe, it } from "@effect/vitest"
import { conformance } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import { makeSlack } from "./slack.ts"
import { channel, slackLayer, team } from "./utils.ts"

/** Rules that need a user's message, a thread's history or a stored file, which the stub does not keep: live.test.ts runs them. */
const liveOnly = new Set([
  "post/files",
  "download/maxBytes",
  "history/sameAsInbound",
  "message/threadStable",
  "inbound/fetchable",
  "inbound/notSelf",
  "nativeStream/concatenates",
  "nativeStream/appendAfterStop",
  "unsupported/getUser"
])

const options = {
  platform: "slack",
  thread: SlackChat.thread({ team, channel }),
  userPosts: () => Effect.die("unused"),
  parseMention: SlackChat.parseMention
}

describe("conformance over the stubbed Web API", () => {
  const names = Object.keys(conformance({
    ...options,
    interactions: { click: () => Effect.void, submit: () => Effect.void, command: () => Effect.void },
    refuseFiles: () => Effect.void
  })).filter((name) => !liveOnly.has(name))

  for (const name of names) {
    it.effect(name, () => {
      const slack = makeSlack()
      const rules = conformance({ ...options, interactions: slack.interactions, refuseFiles: slack.refuseFiles })
      return Effect.andThen(slack.bind, rules[name]).pipe(Effect.provide(slackLayer(slack.fake)))
    })
  }
})

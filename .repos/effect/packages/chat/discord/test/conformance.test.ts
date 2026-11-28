/**
 * The conformance rules for files, buttons, modals and commands, against the adapter
 * over a stubbed `DiscordREST` that keeps what was posted. Clicks and
 * submits are built from the posted components and go through
 * `DiscordChat.interaction`, so the callback answers are tested too.
 */
import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { describe, it } from "@effect/vitest"
import { conformance } from "effect/chat/ChatTest"
import * as Effect from "effect/Effect"
import { makeDiscord } from "./discord.ts"
import { discordLayer, scratch } from "./utils.ts"

const portable = (name: string) =>
  name === "post/refusedFile" ||
  name.startsWith("actions/") ||
  name.startsWith("modal/") ||
  name.startsWith("edit/") && name.endsWith("Actions") ||
  name.startsWith("descriptor/measure") && name.endsWith("Actions") ||
  name.startsWith("command/") ||
  name === "unsupported/buttons" ||
  name === "unsupported/selects" ||
  name === "unsupported/modals" ||
  name === "unsupported/commands" ||
  name === "unsupported/ephemeral"

const rules = (discord: ReturnType<typeof makeDiscord>) =>
  conformance({
    platform: "discord",
    thread: DiscordChat.thread(scratch),
    userPosts: () => Effect.die("unused"),
    parseMention: DiscordChat.parseMention,
    refuseFiles: discord.refuseFiles,
    interactions: discord.interactions
  })

describe("conformance over the stubbed DiscordREST", () => {
  for (const name of Object.keys(rules(makeDiscord())).filter(portable)) {
    it.effect(name, () => {
      const discord = makeDiscord()
      return Effect.andThen(discord.bind, rules(discord)[name]).pipe(Effect.provide(discordLayer(discord.fake)))
    })
  }
})

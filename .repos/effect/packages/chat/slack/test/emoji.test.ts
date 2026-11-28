import { blocksCost } from "@effect/chat-slack/internal/emoji"
import { emojiData } from "@effect/chat-slack/internal/emojiData"
import * as SlackChat from "@effect/chat-slack/SlackChat"
import { assert, describe, it } from "@effect/vitest"
import * as Option from "effect/Option"

const decode = (hex: string): string => String.fromCodePoint(...hex.split("-").map((point) => parseInt(point, 16)))

/** An emoji, and the same without U+FE0F where the table says it is also written so. */
const written = (emoji: string, nonQualified: string | undefined) =>
  nonQualified === "!" ? [emoji, emoji.replaceAll("\uFE0F", "")] : [emoji]

// Every emoji string the generated table defines, read from the table directly
// so the fuzz does not trust emoji.ts to parse it.
const sequences: ReadonlyArray<string> = emojiData.split("\n").flatMap((line) => {
  const [, unified, nonQualified, groups] = line.split("|")
  const variations = groups === undefined ? [] : groups.split(";").flatMap((group) => {
    const [keys, template, variationNonQualified] = group.split(":")
    return keys.split(",").flatMap((tones) => {
      let index = 0
      const emoji = decode(template.replace(/\*/g, () => (0x1f3fb + Number(tones[index++]) - 2).toString(16)))
      return written(emoji, variationNonQualified)
    })
  })
  return [...written(decode(unified), nonQualified), ...variations]
})

describe("emoji", () => {
  it("gives a single tone, or the same tone twice where upstream keys only by two", () => {
    assert.deepStrictEqual(SlackChat.emojiFromName("handshake::skin-tone-3"), Option.some("🤝🏼"))
    assert.deepStrictEqual(SlackChat.emojiFromName("people_holding_hands::skin-tone-4"), Option.some("🧑🏽‍🤝‍🧑🏽"))
    assert.isTrue(Option.isNone(SlackChat.emojiFromName("people_holding_hands::skin-tone-1")))
  })

  // Also the guard for optimised String.prototype.codePointAt, which returned
  // wrong values around lone surrogates on Node 26.8 (V8).
  it("blocksCost is subadditive", () => {
    const extras = [
      "a",
      " ",
      "1",
      "#",
      "\u200D",
      "\uFE0F",
      "\u20E3",
      "🏽",
      "🇺",
      "🇸",
      "🦰",
      "\u{E0067}",
      "\uD83D",
      "\uDE00"
    ]
    let seed = 1
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const piece = () => {
      const kind = random(3)
      if (kind === 0) return extras[random(extras.length)]
      const sequence = sequences[random(sequences.length)]
      if (kind === 1) return sequence
      const from = random(sequence.length + 1)
      const to = random(sequence.length + 1)
      return sequence.slice(Math.min(from, to), Math.max(from, to))
    }
    for (let i = 0; i < 20_000; i++) {
      let text = ""
      for (let j = 1 + random(8); j > 0; j--) text += piece()
      const cut = random(text.length + 1)
      const a = text.slice(0, cut)
      const b = text.slice(cut)
      assert.isAtMost(blocksCost(text), blocksCost(a) + blocksCost(b), JSON.stringify([a, b]))
    }
  })
})

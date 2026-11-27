import { emojiData } from "./emojiData.ts"

interface Entry {
  readonly unified: string
  /** skin_variations keyed by Slack tone digits: "3" or "23" */
  readonly variations: ReadonlyMap<string, string>
}

interface Table {
  readonly byName: ReadonlyMap<string, Entry>
  /** Emoji string (unified or non_qualified, toned or not) to Slack name without colons */
  readonly bySequence: ReadonlyMap<string, string>
  /** First code point of a multi code point sequence to its UTF-16 lengths, longest first */
  readonly lengthsByFirst: ReadonlyMap<number, ReadonlyArray<number>>
  /** Cost of a lone surrogate, the highest cost of any single code point emoji */
  readonly loneSurrogateCost: number
}

const decode = (sequence: string): string => {
  const codePoints = sequence.split("-")
  let out = ""
  for (let i = 0; i < codePoints.length; i++) out += String.fromCodePoint(parseInt(codePoints[i], 16))
  return out
}

const withoutVariationSelector = (emoji: string): string => emoji.replaceAll("\uFE0F", "")

const toneSuffix = (tones: string): string => {
  let out = ""
  for (let i = 0; i < tones.length; i++) out += "::skin-tone-" + tones[i]
  return out
}

// Decoded by hand: optimised String.prototype.codePointAt returned wrong values
// around lone surrogates on Node 26.8 (V8), which broke blocksCost.
const codePointAt = (text: string, index: number): number => {
  const high = text.charCodeAt(index)
  if (high < 0xd800 || high > 0xdbff || index + 1 >= text.length) return high
  const low = text.charCodeAt(index + 1)
  return low < 0xdc00 || low > 0xdfff ? high : (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
}

const build = (): Table => {
  const byName = new Map<string, Entry>()
  const bySequence = new Map<string, string>()
  const lengths = new Map<number, Set<number>>()
  let loneSurrogateCost = 0

  const addSequence = (emoji: string, name: string) => {
    bySequence.set(emoji, name)
    const first = codePointAt(emoji, 0)
    if (emoji.length > (first > 0xffff ? 2 : 1)) {
      let set = lengths.get(first)
      if (set === undefined) lengths.set(first, set = new Set())
      set.add(emoji.length)
    } else {
      loneSurrogateCost = Math.max(loneSurrogateCost, name.length + 2)
    }
  }

  for (const line of emojiData.split("\n")) {
    const [names, unifiedHex, nonQualified, variationGroups] = line.split("|")
    const shortNames = names.split(",")
    const shortName = shortNames[0]
    const unified = decode(unifiedHex)
    addSequence(unified, shortName)
    if (nonQualified !== "") {
      addSequence(nonQualified === "!" ? withoutVariationSelector(unified) : decode(nonQualified), shortName)
    }
    const variations = new Map<string, string>()
    if (variationGroups !== undefined) {
      for (const group of variationGroups.split(";")) {
        const [keys, template, variationNonQualified] = group.split(":")
        for (const tones of keys.split(",")) {
          let index = 0
          const variation = decode(
            template.replace(/\*/g, () => (0x1f3fb + Number(tones[index++]) - 2).toString(16))
          )
          variations.set(tones, variation)
          const name = shortName + toneSuffix(tones)
          addSequence(variation, name)
          if (variationNonQualified === "!") addSequence(withoutVariationSelector(variation), name)
        }
      }
    }
    const entry: Entry = { unified, variations }
    for (const name of shortNames) byName.set(name, entry)
  }

  const lengthsByFirst = new Map<number, ReadonlyArray<number>>()
  for (const [first, set] of lengths) lengthsByFirst.set(first, [...set].sort((a, b) => b - a))

  return { byName, bySequence, lengthsByFirst, loneSurrogateCost }
}

let cached: Table | undefined
const table = (): Table => cached ??= build()

const SKIN_TONE = /^skin-tone-([2-6])$/

/**
 * Resolve a Slack emoji name to its fully qualified emoji.
 *
 * Accepts any alias, with or without surrounding colons, followed by at most
 * one `::skin-tone-N` suffix (`+1::skin-tone-3`). The toned emoji is the
 * upstream `skin_variations` entry with that one tone, or, for a multi-person
 * emoji upstream keys only by two tones (`people_holding_hands`), the entry
 * with that tone twice. A tone the emoji does not have, and a name with two
 * tones, yield `undefined`: no recording shows what Slack sends for a
 * two-tone reaction.
 *
 * @internal
 */
export const fromName = (name: string): string | undefined => {
  const bare = name.length >= 2 && name.startsWith(":") && name.endsWith(":") ? name.slice(1, -1) : name
  const parts = bare.split("::")
  const entry = table().byName.get(parts[0])
  if (entry === undefined) return undefined
  if (parts.length === 1) return entry.unified
  if (parts.length !== 2) return undefined
  const match = SKIN_TONE.exec(parts[1])
  if (match === null) return undefined
  const tone = match[1]
  return entry.variations.get(tone) ?? entry.variations.get(tone + tone)
}

/**
 * Resolve an emoji (fully qualified or not, toned or not) to its primary Slack
 * name without colons, for example `+1` or `+1::skin-tone-3`.
 *
 * @internal
 */
export const toName = (emoji: string): string | undefined => table().bySequence.get(emoji)

/**
 * The longest emoji in the table that starts at `index`, with its name and
 * its length in UTF-16 units, or `undefined`.
 *
 * @internal
 */
export const longestAt = (
  text: string,
  index: number
): { readonly name: string; readonly length: number } | undefined => {
  const { bySequence, lengthsByFirst } = table()
  const codePoint = codePointAt(text, index)
  for (const length of lengthsByFirst.get(codePoint) ?? []) {
    const name = index + length <= text.length ? bySequence.get(text.slice(index, index + length)) : undefined
    if (name !== undefined) return { name, length }
  }
  const width = codePoint > 0xffff ? 2 : 1
  const name = bySequence.get(text.slice(index, index + width))
  return name === undefined ? undefined : { name, length: width }
}

// Code points that are never an emoji on their own but join or modify emoji
// sequences. Charging them more than one keeps blocksCost subadditive: an
// emoji sequence split anywhere costs at least as much as the whole sequence.
const ZERO_WIDTH_JOINER = 0x200d
const COMBINING_ENCLOSING_KEYCAP = 0x20e3
const ZERO_WIDTH_JOINER_COST = 10
const COMBINING_ENCLOSING_KEYCAP_COST = 12
const REGIONAL_INDICATOR_COST = 6
// Slack charges a lone hair component 1 (the spec's four override rows), but
// with this split measure 1 would charge seven hair sequences below their
// names: 🧑‍🦱 would split as :adult: + joiner + 🦱 for 18 against Slack's 21.
// 4 is the least that keeps every hair sequence at its name.
const HAIR_COMPONENT_COST = 4

const codePointCost = (codePoint: number, loneSurrogateCost: number): number => {
  if (codePoint === ZERO_WIDTH_JOINER) return ZERO_WIDTH_JOINER_COST
  if (codePoint === COMBINING_ENCLOSING_KEYCAP) return COMBINING_ENCLOSING_KEYCAP_COST
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return REGIONAL_INDICATOR_COST
  if (codePoint >= 0x1f9b0 && codePoint <= 0x1f9b3) return HAIR_COMPONENT_COST
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return loneSurrogateCost
  return 1
}

/**
 * Measure text the way Slack counts it against the 13,200 character
 * `msg_blocks_too_long` limit: every emoji counts as its `:short_name:` form
 * (`👍🏽` is `:+1::skin-tone-4:`, 17), everything else as one per code point.
 *
 * The result is the cheapest split of the text into emoji and single code
 * points. For every emoji in the table this is exactly its `:short_name:`
 * length, and since the cheapest split of `a + b` is at most the cheapest split
 * of `a` followed by that of `b`, `blocksCost(a + b) <= blocksCost(a) +
 * blocksCost(b)` for all strings. To keep that true when a split lands inside an
 * emoji, code points that only occur inside emoji sequences (zero width
 * joiner, keycap, regional indicators, hair components) cost more than one
 * when they stand alone, and so does a lone surrogate.
 *
 * Runs in O(text length × candidate sequence lengths).
 *
 * @internal
 */
export const blocksCost = (text: string): number => {
  const { bySequence, lengthsByFirst, loneSurrogateCost } = table()
  const length = text.length
  // costs[i] is the cheapest cost of text.slice(0, i), -1 when i is inside a code point
  const costs = new Int32Array(length + 1).fill(-1)
  costs[0] = 0
  for (let i = 0; i < length; i++) {
    const before = costs[i]
    if (before < 0) continue
    const codePoint = codePointAt(text, i)
    const width = codePoint > 0xffff ? 2 : 1
    const single = bySequence.get(text.slice(i, i + width))
    const singleCost = before + (single === undefined ? codePointCost(codePoint, loneSurrogateCost) : single.length + 2)
    if (costs[i + width] < 0 || singleCost < costs[i + width]) costs[i + width] = singleCost
    const candidates = lengthsByFirst.get(codePoint)
    if (candidates === undefined) continue
    for (const candidate of candidates) {
      const end = i + candidate
      if (end > length) continue
      const name = bySequence.get(text.slice(i, end))
      if (name === undefined) continue
      const cost = before + name.length + 2
      if (costs[end] < 0 || cost < costs[end]) costs[end] = cost
    }
  }
  return costs[length]
}

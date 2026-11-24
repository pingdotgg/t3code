import type { Action } from "effect/chat/ChatUi"
import * as Actions from "./actions.ts"
import { blocksCost } from "./emoji.ts"

/** `msg_too_long`: code points of `markdown_text` as sent, inclusive. @internal */
export const messageLength = 12_000

/** @internal */
export const codePoints = (text: string): number => {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) i++
    }
    count++
  }
  return count
}

const lessThan = (text: string): number => {
  let count = 0
  for (let i = text.indexOf("<"); i !== -1; i = text.indexOf("<", i + 1)) count++
  return count
}

/**
 * What a Markdown string and the elements beside it cost against
 * `messageLength`, as an upper bound that adds up. It is the larger of two
 * counts: code points plus three for every `<`, which may be sent as
 * `&lt;`, and Slack's 13,200 count, scaled to 12,000, of the text with each
 * emoji as its shortcode plus the `actions` block's stored JSON.
 *
 * @internal
 */
export const measure = (markdown: string, actions?: ReadonlyArray<Action>): number =>
  Math.max(
    codePoints(markdown) + 3 * lessThan(markdown),
    Math.ceil((blocksCost(markdown) + Actions.cost(Actions.elements(actions ?? []))) * 10 / 11)
  )

/**
 * The `text` the adapter sends beside a `markdown` block on
 * `chat.postMessage` and `chat.update`. Slack decides who a message
 * mentions from this field, not from the blocks, so the adapter always
 * builds it itself: Slack's own would carry every token intact.
 */
import type { Action } from "effect/chat/ChatUi"
import * as Actions from "./actions.ts"
import * as Escape from "./escape.ts"
import { codePoints } from "./length.ts"
import { escapeMarkdown } from "./richText.ts"

/**
 * The budget for `text` on `chat.postMessage`, in code points. Slack cuts a
 * longer one there without an error, and the cut can split an entity or a
 * token.
 *
 * @internal
 */
export const postTextLength = 16_000

/**
 * The budget for `text` on `chat.update`, in UTF-8 bytes. Slack refuses a
 * `text` over 4,000 bytes with `msg_too_long`.
 *
 * Provisional: whether Slack checks the 4,000 before or after it rewrites the
 * text (it wraps a URL in `<…>`) is not known yet, so this keeps a reserve.
 *
 * @internal
 */
export const updateTextBytes = 3_800

/** @internal */
export interface Budget {
  readonly unit: "codePoints" | "utf8"
  readonly limit: number
}

/** @internal */
export const postBudget: Budget = { unit: "codePoints", limit: postTextLength }

/** @internal */
export const updateBudget: Budget = { unit: "utf8", limit: updateTextBytes }

/** @internal */
export const utf8Bytes = (text: string): number => {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) count += 1
    else if (code < 0x800) count += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        count += 4
        i++
      } else {
        count += 3
      }
    } else {
      // A lone surrogate goes out as U+FFFD, which is three bytes too.
      count += 3
    }
  }
  return count
}

/** @internal */
export const cost = (text: string, unit: Budget["unit"]): number => unit === "utf8" ? utf8Bytes(text) : codePoints(text)

const marker = "…"
const separator = " "

let segmenter: Intl.Segmenter | undefined

const entity = /&(?:lt|gt|amp);/g

/** @internal */
export interface Built {
  readonly text: string
  /** Allowed tokens that a cut had no room for. */
  readonly dropped: number
}

/**
 * Builds the `text` for a Markdown body and cuts it to `budget`.
 *
 * - Every `<`, `>` and `&` is an entity, in code too. The tokens the notify
 *   options allow, outside code, stay intact, as they do in the block.
 * - Past the budget, the text is cut on a grapheme cluster boundary that
 *   splits no entity and no token, and ends in `…`. Each allowed token not
 *   in the kept part is appended once, in order, after a space. The marker
 *   and the spaces come out of the budget.
 * - When the tokens alone don't fit, those that fit are kept and the rest
 *   counted in `dropped`.
 *
 * @internal
 */
export const build = (markdown: string, notify: Escape.Notify, budget: Budget): Built => {
  const spans: Array<readonly [number, number]> = []
  const text = Escape.escape(markdown, notify, {
    flush: true,
    entities: true,
    onToken: (start, end) => spans.push([start, end])
  }).sent
  const tokens = spans.map(([start, end]) => text.slice(start, end))
  if (cost(text, budget.unit) <= budget.limit) return { text, dropped: 0 }

  // Offsets inside an entity or a token, where no cut may fall.
  const inside = new Uint8Array(text.length + 1)
  const atomic = (start: number, end: number) => inside.fill(1, start + 1, end)
  for (const [start, end] of spans) atomic(start, end)
  entity.lastIndex = 0
  for (let match = entity.exec(text); match !== null; match = entity.exec(text)) {
    atomic(match.index, match.index + match[0].length)
  }

  // The tail is the marker plus each distinct token not yet in the head.
  const distinct = [...new Set(tokens)]
  const unit = budget.unit
  const tokenCost = (token: string) => cost(separator + token, unit)
  let tail = cost(marker, unit)
  for (const token of distinct) tail += tokenCost(token)

  // Every code point boundary outside an entity or a token where the head
  // and the tail fit, from the start until the head alone is over.
  const candidates: Array<number> = []
  const inHead = new Set<string>()
  let head = 0
  let span = 0
  let i = 0
  for (;;) {
    for (; span < spans.length && spans[span][1] <= i; span++) {
      const token = tokens[span]
      if (!inHead.has(token)) {
        inHead.add(token)
        tail -= tokenCost(token)
      }
    }
    if (inside[i] === 0 && head + tail <= budget.limit) candidates.push(i)
    if (i >= text.length) break
    const code = text.charCodeAt(i)
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff
    // A lone surrogate goes out as U+FFFD, three bytes.
    head += unit === "codePoints" ? 1 : pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3
    i += pair ? 2 : 1
    if (head > budget.limit) break
  }

  // The last of them on a grapheme cluster boundary.
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" })
  let best = -1
  let candidate = 0
  // Iterate boundaries: Bun's containing() reports incorrect offsets for astral text.
  for (const { index } of segmenter.segment(text)) {
    while (candidate < candidates.length && candidates[candidate] < index) candidate++
    if (candidate === candidates.length) break
    if (candidates[candidate] === index) best = index
  }

  if (best >= 0) {
    const kept = text.slice(0, best)
    let out = kept + marker
    for (const token of distinct) if (!kept.includes(token)) out += separator + token
    return { text: out, dropped: 0 }
  }
  // Not even the tokens fit: keep those that do, in order.
  let out = marker
  let used = cost(marker, unit)
  let dropped = 0
  for (const token of distinct) {
    const extra = tokenCost(token)
    if (used + extra <= budget.limit) {
      out += separator + token
      used += extra
    } else {
      dropped++
    }
  }
  return { text: out, dropped }
}

/** @internal */
export interface Body {
  /** The Markdown as sent in the block, for the length check. */
  readonly sent: string
  readonly blocks: ReadonlyArray<unknown>
  readonly text: string
  readonly dropped: number
}

/**
 * The content of a `chat.postMessage` or `chat.update`: the Markdown as one
 * `markdown` block, escaped as `markdown_text` was, then the elements as
 * one `actions` block, and the `text` from `build`.
 *
 * With elements and no Markdown there is no `markdown` block, and `text`
 * is the button labels joined by a space, escaped. Slack's own fallback,
 * which appends the word "button" to each label, never appears.
 *
 * @internal
 */
export const body = (
  markdown: string,
  notify: Escape.Notify,
  budget: Budget,
  actions: ReadonlyArray<Action> = []
): Body => {
  if (markdown === "" && actions.length > 0) {
    const built = build(Actions.labels(actions), {}, budget)
    return withActions({ sent: "", blocks: [], text: built.text, dropped: built.dropped }, actions)
  }
  const sent = Escape.escape(markdown, notify, { flush: true }).sent
  const built = build(markdown, notify, budget)
  return withActions(
    { sent, blocks: [{ type: "markdown", text: sent }], text: built.text, dropped: built.dropped },
    actions
  )
}

/**
 * `body` with the elements' `actions` block last, when there are any.
 *
 * @internal
 */
export const withActions = (body: Body, actions: ReadonlyArray<Action>): Body =>
  actions.length === 0 ? body : { ...body, blocks: [...body.blocks, Actions.block(actions)] }

/**
 * Whether `body` has an `actions` block, which is content enough without
 * `text`.
 *
 * @internal
 */
export const hasActions = (body: Body): boolean =>
  body.blocks.some((block) => (block as { readonly type?: unknown }).type === "actions")

/**
 * The content of a post with files and no Markdown: the file names joined by
 * ", ", escaped as Markdown in the block so they render as written, and with
 * entities in `text`. No token in a name is allowed. It stays as the
 * message.
 *
 * @internal
 */
export const placeholder = (names: ReadonlyArray<string>, budget: Budget): Body => {
  const joined = names.join(", ")
  const sent = Escape.escape(escapeMarkdown(joined), {}, { flush: true }).sent
  const built = build(joined, {}, budget)
  return { sent, blocks: [{ type: "markdown", text: sent }], text: built.text, dropped: built.dropped }
}

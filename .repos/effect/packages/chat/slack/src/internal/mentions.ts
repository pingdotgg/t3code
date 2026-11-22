import type { Mention } from "effect/chat/ChatMessage"
import { isObject } from "effect/Predicate"

type Kind = Mention["kind"]

interface Target {
  readonly kind: Kind
  readonly id: string
}

/** A mention token in `text`, as Slack writes it. */
const tokenPattern =
  /<(@([UW][A-Z0-9]+)|!subteam\^([A-Z0-9]+)|#(C[A-Z0-9]+|G[A-Z0-9]+)|!(here|channel|everyone))(\|[^<>]*)?>/g

/**
 * Parses one token, `<@U123>`, `<!subteam^S123|@team>`, `<#C123|name>` or
 * `<!here>`, as the whole of `slice`.
 *
 * @internal
 */
export const parseToken = (slice: string): Target | undefined => {
  tokenPattern.lastIndex = 0
  const match = tokenPattern.exec(slice)
  if (match === null || match.index !== 0 || match[0].length !== slice.length) return undefined
  return targetOf(match)
}

const targetOf = (match: RegExpExecArray): Target => {
  const [, , user, group, channel, broadcast] = match
  if (user !== undefined) return { kind: "user", id: user }
  if (group !== undefined) return { kind: "role", id: group }
  if (channel !== undefined) return { kind: "channel", id: channel }
  return { kind: "broadcast", id: broadcast! }
}

interface Token extends Target {
  readonly start: number
  readonly end: number
}

const tokens = (text: string, skipCode: boolean): Array<Token> => {
  const code: Array<readonly [number, number]> = []
  if (skipCode) {
    const codePattern = /```[\s\S]*?```|`[^`\n]+`/g
    for (let match = codePattern.exec(text); match !== null; match = codePattern.exec(text)) {
      code.push([match.index, match.index + match[0].length])
    }
  }
  const found: Array<Token> = []
  tokenPattern.lastIndex = 0
  for (let match = tokenPattern.exec(text); match !== null; match = tokenPattern.exec(text)) {
    const start = match.index
    if (code.some(([from, to]) => start >= from && start < to)) continue
    found.push({ ...targetOf(match), start, end: start + match[0].length })
  }
  return found
}

interface Item extends Target {
  readonly real: boolean
}

/**
 * The items of a message's `rich_text` blocks that a token in `text` can
 * stand for, in order. A `user`, `usergroup`, `channel` or `broadcast`
 * element is a real mention, unless it has code style or sits in a
 * preformatted section. A token-shaped string in text elements (adjacent
 * ones joined) is a literal, as is a code-styled element. `undefined` when
 * the message has no `rich_text` block.
 */
const richTextItems = (blocks: unknown): Array<Item> | undefined => {
  if (!Array.isArray(blocks)) return undefined
  const rich = blocks.filter((block) => isObject(block) && block.type === "rich_text")
  if (rich.length === 0) return undefined
  const items: Array<Item> = []
  let pending = ""
  const flushText = () => {
    if (pending === "") return
    for (const token of tokens(pending, false)) items.push({ kind: token.kind, id: token.id, real: false })
    pending = ""
  }
  const walk = (element: unknown, inCode: boolean): void => {
    if (!isObject(element)) return
    const code = inCode || element.type === "rich_text_preformatted"
    const style = element.style
    const literal = code || (isObject(style) && style.code === true)
    let target: Target | undefined
    switch (element.type) {
      case "text":
        if (typeof element.text === "string") pending += element.text
        return
      case "user":
        if (typeof element.user_id === "string") target = { kind: "user", id: element.user_id }
        break
      case "usergroup":
        if (typeof element.usergroup_id === "string") target = { kind: "role", id: element.usergroup_id }
        break
      case "channel":
        if (typeof element.channel_id === "string") target = { kind: "channel", id: element.channel_id }
        break
      case "broadcast":
        if (typeof element.range === "string") target = { kind: "broadcast", id: element.range }
        break
    }
    if (target !== undefined) {
      flushText()
      items.push({ ...target, real: !literal })
      return
    }
    if (Array.isArray(element.elements)) {
      flushText()
      for (const child of element.elements) walk(child, code)
      flushText()
    }
  }
  for (const block of rich) walk(block, false)
  flushText()
  return items
}

const sameTarget = (a: Target, b: Target): boolean => a.kind === b.kind && a.id === b.id

/** Past this many item and token pairs, the alignment is skipped for the fallback. */
const maxAlignment = 1_000_000

/**
 * Aligns the tokens in `text` with the block's items, in order. Every real
 * item takes a token it equals, a literal item may take one or be passed
 * over, and a token may stand for no item. Of the alignments, the one that
 * pairs the most items wins, the earliest pairing first. Gives the token
 * index of each real item, or `undefined` when no alignment pairs them all.
 */
const align = (items: ReadonlyArray<Item>, found: ReadonlyArray<Token>): Array<number> | undefined => {
  const n = items.length
  const m = found.length
  if ((n + 1) * (m + 1) > maxAlignment) return undefined
  const impossible = -1
  const width = m + 1
  // best[i * width + j]: the most pairs for items i.. and tokens j.., or
  // impossible when some real item among i.. can't be paired. Row n, no
  // items left, is all zero.
  const best = new Int32Array((n + 1) * width)
  const pairs = (i: number, j: number): number => {
    if (j === m || !sameTarget(items[i], found[j])) return impossible
    const rest = best[(i + 1) * width + j + 1]
    return rest === impossible ? impossible : rest + 1
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      let score = pairs(i, j)
      if (!items[i].real) score = Math.max(score, best[(i + 1) * width + j])
      if (j < m) score = Math.max(score, best[i * width + j + 1])
      best[i * width + j] = score
    }
  }
  if (best[0] === impossible) return undefined
  const out: Array<number> = []
  let i = 0
  let j = 0
  // Every step moves i or j forward, so this ends after n + m steps.
  while (i < n) {
    const score = best[i * width + j]
    if (pairs(i, j) === score) {
      if (items[i].real) out.push(j)
      i++
      j++
    } else if (!items[i].real && best[(i + 1) * width + j] === score) {
      i++
    } else if (j < m && best[i * width + j + 1] === score) {
      j++
    } else {
      return undefined
    }
  }
  return out
}

/**
 * The mentions of a message with offsets into `text`.
 *
 * - With a `rich_text` block, the mentions are its real mention elements
 *   whose token is in `text`, since Slack decides a mention from `text`. A
 *   real element with no token there is not reported, however long the
 *   message. Offsets come from aligning the tokens in `text` with the
 *   block's items, in order. When no alignment places every real item,
 *   because `text` has fewer occurrences of a token than the block, each
 *   real item takes the next unused token it equals, and one with none left
 *   is not reported. `text` never adds a mention.
 * - Without one, `text` is scanned, skipping backtick code spans and fences.
 *   That covers Block Kit posts, attachment-only posts and system messages.
 *
 * @internal
 */
export const extract = (
  text: string,
  blocks: unknown,
  botUserId: string
): Array<Mention> => {
  const toMention = (token: Token): Mention => ({
    kind: token.kind,
    id: token.id,
    start: token.start,
    end: token.end,
    isSelf: token.kind === "user" && token.id === botUserId
  })
  const items = richTextItems(blocks)
  if (items === undefined) return tokens(text, true).map(toMention)
  const found = tokens(text, false)
  const aligned = align(items, found)
  if (aligned !== undefined) return aligned.map((index) => toMention(found[index]))
  const used = new Set<number>()
  const mentions: Array<Mention> = []
  let from = 0
  for (const item of items) {
    if (!item.real) continue
    let index = found.findIndex((token, k) => k >= from && !used.has(k) && sameTarget(item, token))
    if (index < 0) index = found.findIndex((token, k) => !used.has(k) && sameTarget(item, token))
    if (index < 0) continue
    used.add(index)
    from = index + 1
    mentions.push(toMention(found[index]))
  }
  return mentions.sort((x, y) => x.start - y.start)
}

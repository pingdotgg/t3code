/**
 * Rich Markdown for `sendRichMessage`: the escaping that keeps consumer
 * Markdown from reaching Telegram's raw HTML, images, math, spoilers and
 * non-web links, and the `measure` that bounds what it costs.
 *
 * @internal
 */

/** What one line break or block marker costs, so that a message in budget stays under 500 blocks. @internal */
export const block = 65

/** Telegram's rich message limit. It counts rendered characters, which UTF-8 bytes of the source bound. @internal */
export const richLimit = 32_768

/** Files one post may carry. @internal */
export const filesPerMessage = 10

/** The most nesting and table columns Telegram renders. @internal */
export const maxDepth = 16

/** @internal */
export const maxColumns = 20

/** The reference to the `n`th file of a post, at the end of the Markdown. @internal */
export const mediaReference = (n: number): string => `\n\n![](tg://document?id=f${n})`

/**
 * What the budget keeps back for media references and the fence a post
 * with files may need to close: each reference's bytes and its block, one
 * block for the message's first, which `measure` does not charge, and 8
 * bytes for the fence.
 *
 * @internal
 */
export const reservation = filesPerMessage * (32 + block) + block + 8

/** @internal */
export const messageLength = richLimit - reservation

const twoByteEscapes = new Set(["$", "=", "|", "!", "[", "]", "*", "_", "~", "`"])
const blockMarkers = new Set([">", "-", "+", "*", ".", ")"])

const isDigit = (c: string) => c >= "0" && c <= "9"

/**
 * A sum of per-character costs, each fixed or depending only on what comes
 * before the character on its own line, which makes it subadditive:
 *
 * - a code point in the Basic Multilingual Plane costs its UTF-8 length,
 *   and each UTF-16 surrogate 3, enough for the U+FFFD a lone one becomes.
 *   NUL costs 3 too, as Markdown turns it into U+FFFD.
 * - `<` costs 4, a backslash 5 (the numeric reference, such as `&#93;`,
 *   that an escape Telegram ignores becomes), and
 *   `$ = | ! [ ] * _ ~` and the backtick 2, their escaped length or more,
 *   whether or not they are escaped in context.
 * - `\n` and `\r` cost `block`, as does a block marker (`>`, a bullet,
 *   the dot or parenthesis of a number) before any other text on its line.
 *
 * @internal
 */
export const measure = (markdown: string): number => {
  let cost = 0
  let prefix = true
  for (let i = 0; i < markdown.length; i++) {
    const code = markdown.charCodeAt(i)
    if (code === 10 || code === 13) {
      cost += block
      prefix = true
      continue
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      cost += 3
      prefix = false
      continue
    }
    const c = markdown[i]
    if (prefix) {
      if (c === " " || c === "\t" || isDigit(c)) {
        cost += 1
        continue
      }
      if (blockMarkers.has(c)) {
        cost += block
        continue
      }
      prefix = false
    }
    cost += c === "\\"
      ? 5
      : code === 0
      ? 3
      : c === "<"
      ? 4
      : twoByteEscapes.has(c)
      ? 2
      : code < 0x80
      ? 1
      : code < 0x800
      ? 2
      : 3
  }
  return cost
}

const punctuation = /[!-/:-@[-`{-~]/

/** A line that opens a fence: up to three spaces, then three or more backticks or tildes. */
const fenceOpen = /^( {0,3})(`{3,}|~{3,})(.*)$/

interface Fence {
  readonly char: string
  readonly length: number
  readonly indent: number
}

const opens = (line: string): Fence | undefined => {
  const match = fenceOpen.exec(line)
  if (match === null || (match[2][0] === "`" && match[3].includes("`"))) return undefined
  return { char: match[2][0], length: match[2].length, indent: match[1].length }
}

const closes = (line: string, fence: Fence): boolean => {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.length
}

/** A line that may open a list item or footnote, which an indented fence could belong to. */
const container = /^[ \t>]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|^[ \t>]*\[\^/

/** A line GFM may read as the start of another block, which ends a table and is no paragraph. */
const blockStart = /^(?: {0,3}[#>\-*+_~`<=[]| {0,3}\d{1,9}[.)]| {4}| {0,3}\t)/

/** Where a line's container markers end, as far as `startsBlock` needs to know. */
const quotes = /^(?: {0,3}> ?)* {0,3}/

/**
 * Whether a line starts a block wherever it is, so that it can be no
 * paragraph's continuation: an ATX heading, or a list item with content
 * that may interrupt a paragraph (a bullet, or an ordered item numbered 1
 * or following one of its list). Tabs and other lines say no, which is
 * safe: the inline count goes on.
 */
const startsBlock = (line: string, previousItem: string | undefined): string | undefined | true => {
  const rest = line.slice(quotes.exec(line)![0].length)
  if (/^(?:#{1,6}(?: |$)|[-+*] +\S)/.test(rest)) return true
  const item = /^(\d{1,9})([.)]) +\S/.exec(rest)
  if (item === null) return undefined
  const key = line.slice(0, line.length - rest.length) + item[2]
  return item[1] === "1" || key === previousItem ? key : undefined
}

const delimiterRow = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/

/** The cells of a table row, split at unescaped pipes as GFM does, even inside code. */
const cellCount = (line: string): number => {
  let count = 1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++
    else if (line[i] === "|") count++
  }
  const trimmed = line.trim()
  if (trimmed.startsWith("|")) count--
  if (trimmed.length > 1 && trimmed.endsWith("|") && !trimmed.endsWith("\\|")) count--
  return count
}

/**
 * A blank line as CommonMark defines it: only spaces and tabs. Other
 * whitespace, such as U+00A0, is paragraph text and ends nothing.
 */
const isBlank = (line: string): boolean => /^[ \t]*$/.test(line)

/** Whether a line can head a table: GFM reads no cell in a lone `|`. */
const hasPipe = (line: string) => (cellCount(line) > 1 || line.trim().startsWith("|")) && line.trim() !== "|"

/** The decoded form of a link destination, as a Markdown parser and then a URL parser read it. */
const decodeDestination = (raw: string): { readonly unescaped: string; readonly decoded: string } | undefined => {
  let unescaped = raw.replace(/\\([!-/:-@[-`{-~])/g, "$1")
  unescaped = unescaped.replace(/&#(\d{1,7});/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_, name: string) =>
        name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? "\"" : "'"
    )
  // Any other named reference could be one of HTML's many, such as `&colon;`.
  if (/&[A-Za-z][A-Za-z0-9]*;/.test(unescaped)) return undefined
  try {
    return { unescaped, decoded: decodeURIComponent(unescaped) }
  } catch {
    return undefined
  }
}

const allowedScheme = /^(?:https?:\/\/|mailto:)/i

/** Whether a link to `raw` may stay: http, https and mailto, or a mention the post allows. */
const allowedDestination = (raw: string, mentions: ReadonlySet<string>): boolean => {
  const destination = decodeDestination(raw)
  if (destination === undefined) return false
  if (allowedScheme.test(destination.unescaped) && allowedScheme.test(destination.decoded)) return true
  const mention = /^tg:\/\/user\?id=(\d{1,20})$/.exec(destination.decoded)
  return mention !== null && destination.unescaped === destination.decoded && mentions.has(mention[1])
}

const blank = (c: string | undefined): boolean => c === " " || c === "\t"

/**
 * The deepest parentheses a kept destination may nest. CommonMark lets a
 * parser refuse deeper ones once it supports three, and GFM refuses past
 * 32 in a link, which would leave the rest of the link as Markdown.
 */
const maxDestinationDepth = 3

/**
 * The destination and optional title from `start`, as CommonMark reads
 * them when they are on this line: a destination not in angle brackets, up
 * to a space, a control character or a `)` it did not open, with its
 * parentheses balanced and at most three deep, then a title after a space. `end` is past the
 * title and the blanks after it.
 */
const destinationAndTitle = (
  line: string,
  start: number
): { readonly destination: string; readonly end: number } | undefined => {
  let i = start
  while (blank(line[i])) i++
  if (line[i] === "<") return undefined
  const from = i
  let depth = 0
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === "\\" && punctuation.test(line[i + 1] ?? "")) {
      i++
      continue
    }
    const code = c.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f) break
    if (c === "(") {
      if (++depth > maxDestinationDepth) return undefined
    } else if (c === ")") {
      if (depth === 0) break
      depth--
    }
  }
  if (depth > 0) return undefined
  const destination = line.slice(from, i)
  const spaced = blank(line[i])
  while (blank(line[i])) i++
  const open = line[i]
  if (spaced && (open === "\"" || open === "'" || open === "(")) {
    const close = open === "(" ? ")" : open
    for (i++; i < line.length && line[i] !== close; i++) {
      if (line[i] === "\\" && punctuation.test(line[i + 1] ?? "")) i++
      else if (open === "(" && line[i] === "(") return undefined
    }
    if (i >= line.length) return undefined
    i++
    while (blank(line[i])) i++
  }
  return { destination, end: i }
}

/**
 * A link's `(destination "title")` from the `(` at `start`, when all of it
 * is on this line. A tail that goes on to the next line, as CommonMark
 * allows, is not one: the link is then refused.
 */
const linkTail = (line: string, start: number): { readonly destination: string; readonly end: number } | undefined => {
  const tail = destinationAndTitle(line, start + 1)
  return tail !== undefined && line[tail.end] === ")" ? { destination: tail.destination, end: tail.end + 1 } : undefined
}

/**
 * The punctuation whose backslash escape Telegram honors. Before any other
 * punctuation the backslash stays as text and the character is read as
 * syntax: `\<b>` is bold. `\]` hides the bracket from emphasis but still
 * closes a link or a definition label, so it is not here either.
 */
const honored = new Set("!#$()*+-.=>[\\_`{|}~")

/** A consumer's escape of `c` as Telegram reads it: kept, or a numeric character reference. */
const escapeOf = (c: string): string => honored.has(c) ? "\\" + c : `&#${c.charCodeAt(0)};`

/**
 * A kept destination as Telegram needs it. Telegram reads a destination
 * verbatim, with no escapes, so they are decoded, a parenthesis or
 * backslash percent-encoded, and a `<` too, which would end the link.
 */
const destinationOf = (raw: string): string =>
  raw.replace(/\\([!-/:-@[-`{-~])|</g, (match, escaped: string | undefined) => {
    const c = escaped ?? match
    return percentEncoded[c] ?? c
  })

const percentEncoded: Readonly<Record<string, string>> = {
  "(": "%28",
  ")": "%29",
  "\\": "%5C",
  "<": "%3C",
  ">": "%3E"
}

/**
 * The destination of a reference definition after `]:`, when the rest of
 * the line is a nonempty destination and an optional title. Anything else
 * after it, a title that goes on to the next line, or a destination there,
 * makes it no definition here.
 */
const definitionDestination = (line: string, start: number): string | undefined => {
  const tail = destinationAndTitle(line, start)
  return tail !== undefined && tail.end === line.length ? tail.destination : undefined
}

/** The most characters CommonMark reads between a label's brackets. */
const maxLabelLength = 999

/**
 * The most characters the renderer can make of a simple label: an escape
 * becomes at most `%5C&lt;`, and each of `$ = | * _ ~` at most two. The
 * label it sends, not the consumer's, must fit in 999.
 */
const renderedLabelBound = (text: string): number => {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      n += 7
      i++
    } else n += "$=|*_~".includes(text[i]) ? 2 : 1
  }
  return n
}

/**
 * A label CommonMark and the renderer both close at its first `]`: no
 * other bracket, code span or autolink in it, and no escape at its end.
 */
const simpleLabel = /^(?:[^\\[\]`<]|\\.)*$/

/**
 * The reference definition the line whose first `[` is at `start` may
 * keep: a simple label, not blank, not a footnote's and at most 999
 * characters once rendered, closed by `]:`, then a destination it allows.
 */
const keptDefinition = (
  line: string,
  start: number,
  mentions: ReadonlySet<string>
): { readonly close: number; readonly destination: string } | undefined => {
  const close = line.indexOf("]", start)
  const text = line.slice(start + 1, close)
  if (
    close < 0 || line[close + 1] !== ":" || !simpleLabel.test(text) || isBlank(text) || text[0] === "^" ||
    renderedLabelBound(text) > maxLabelLength
  ) return undefined
  const destination = definitionDestination(line, close + 2)
  return destination !== undefined && allowedDestination(destination, mentions) ? { close, destination } : undefined
}

/**
 * The end of the code span whose opening backticks are at `start`, found as
 * CommonMark finds it: the next run of as many backticks on the line. A
 * run with no partner on the line opens no span: the renderer escapes it,
 * so no span can pair across lines. In a table row a span holding a pipe
 * is refused, since GFM splits cells before it reads code.
 */
const codeSpanEnd = (line: string, start: number, tableRow: boolean): number | undefined => {
  let length = 0
  while (line[start + length] === "`") length++
  for (let j = start + length; j < line.length;) {
    if (line[j] !== "`") {
      j++
      continue
    }
    let run = 0
    while (line[j + run] === "`") run++
    if (run === length) return tableRow && line.slice(start, j).includes("|") ? undefined : j + run
    j += run
  }
  return undefined
}

/**
 * Where GFM starts a bare URL link. It runs to the next space, taking
 * backslashes and backticks with it, so inside one an escape is not
 * needed and a backtick opens no span.
 */
const bareUrl = /^(?:https?:\/\/|www\.)/i

/** A thematic break, whose delimiters stand alone. */
const thematicBreak = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

const autolink = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):[^\s<>`\p{Cc}]*>/u

/**
 * What one paragraph may already nest. `open` counts every delimiter that
 * could open emphasis, and none is taken back for one that may close it:
 * whether a run closes, and what, depends on flanking rules and links that
 * this renderer does not follow, and a node needs at least one opener.
 * `containers` is the most container depth of the paragraph's lines, as a
 * lazy continuation line stays in containers it does not repeat. `nodes`
 * counts the code spans, links and footnote references, which Telegram
 * caps per paragraph.
 */
interface Inline {
  open: number
  containers: number
  nodes: number
}

/** The inline nodes one paragraph may hold. Telegram refuses a paragraph past about 4,387. @internal */
export const maxInlineNodes = 4000

/** What one footnote reference costs against `maxInlineNodes`: its superscript, anchor and link. */
const footnoteNodes = 3

/** The footnote references one message may hold. Telegram refuses about 774 to one footnote. @internal */
export const maxFootnoteReferences = 700

interface LineContext {
  readonly tableRow: boolean
  /** Whether GFM may read the line as a table row, which splits code spans at pipes. */
  readonly cells: boolean
  readonly widePipes: boolean
  readonly setext: boolean
  readonly inline: Inline
  readonly mentions: ReadonlySet<string>
  /** Footnote references so far in the message. */
  readonly footnotes: { count: number }
  /**
   * Whether a definition may start this line: after a blank line, the
   * start of the text or another definition, outside containers. Set to
   * whether this line kept one.
   */
  readonly definitions: { allowed: boolean }
}

/**
 * The container markers at the start of a line, with those past the depth
 * limit escaped, and where the line's text starts.
 */
const renderPrefix = (line: string): { readonly text: string; readonly rest: number; readonly depth: number } => {
  let out = ""
  let i = 0
  let depth = 0
  let indent = 0
  for (;;) {
    const space = /^[ \t]*/.exec(line.slice(i))![0]
    indent += space.length
    out += space
    i += space.length
    const marker = /^(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/.exec(line.slice(i))
    if (marker === null) break
    depth++
    const token = marker[0]
    const escape = depth + Math.floor(indent / 2) >= maxDepth
    out += escape ? token.slice(0, -1) + "\\" + token.slice(-1) : token
    i += token.length
  }
  return { text: out, rest: i, depth: depth + Math.floor(indent / 2) }
}

const renderLine = (line: string, context: LineContext): string => {
  const prefix = renderPrefix(line)
  // A footnote definition opens a block, so not behind a tab or four
  // spaces: there, after a definition, GFM reads one with a label `^a`.
  const indent = /[ \t]*$/.exec(line.slice(0, prefix.rest))![0]
  const footnote = !indent.includes("\t") && indent.length < 4 && /^\[\^[\w-]+\]:/.test(line.slice(prefix.rest))
  const inline = context.inline
  inline.containers = Math.max(inline.containers, prefix.depth)
  const limit = Math.max(0, maxDepth - 1 - inline.containers)
  /** Counts `n` inline nodes, or says no when the paragraph has no room left. */
  const node = (n: number): boolean => {
    if (inline.nodes + n > maxInlineNodes) return false
    inline.nodes += n
    return true
  }
  // Telegram reads a definition wherever the line's first `[` closes at a
  // `]:`, also past other brackets, code or autolinks, and GFM reads one
  // at the start of a footnote's text. One is kept only where CommonMark
  // reads the same, with a label and destination both accept. Otherwise
  // the line's `[` is escaped before it is read, so no raw destination is
  // sent behind a label that is text.
  const shaped = line[prefix.rest] === "[" &&
    line.includes("]:", footnote ? line.indexOf("]:", prefix.rest) + 2 : prefix.rest)
  const definition = shaped && context.definitions.allowed && prefix.depth === 0 ?
    keptDefinition(line, prefix.rest, context.mentions) :
    undefined
  context.definitions.allowed = false
  // Where the line's opening `[` is in `out`, while it may close on a later line.
  const label = line[prefix.rest] === "[" ? prefix.text.length : undefined
  // Where the `[` of a label with no other bracket in it is, until a `]`
  // closes it. Only such a label keeps its destination: around a nested
  // label, a reference or a footnote, whether the outer brackets make a
  // link depends on definitions and on Telegram's precedence, and a raw
  // tail would be read as Markdown.
  let opener: number | undefined
  // Where each `[` not yet closed on this line is in `out`.
  const unclosed: Array<number> = []
  let out = prefix.text
  let urlEnd = -1
  let i = prefix.rest
  if (shaped && definition === undefined) {
    out += "\\["
    i++
  }
  while (i < line.length) {
    const c = line[i]
    const next = line[i + 1]
    if (i >= urlEnd && bareUrl.test(line.slice(i, i + 8))) {
      urlEnd = i
      while (urlEnd < line.length && line[urlEnd] !== " " && line[urlEnd] !== "\t") urlEnd++
    }
    const inUrl = i < urlEnd
    // In a bare URL a backslash escapes nothing, outside one it does: as
    // `%5C` it is the same character to a browser and inert to both.
    if (c === "\\" && inUrl && next !== undefined && punctuation.test(next)) {
      out += "%5C"
      i++
      continue
    }
    if (c === "\\" && next !== undefined && punctuation.test(next)) {
      out += escapeOf(next)
      i += 2
      continue
    }
    switch (c) {
      case "`": {
        const end = inUrl ? undefined : codeSpanEnd(line, i, context.cells)
        if (end !== undefined && node(1)) {
          out += line.slice(i, end)
          i = end
          continue
        }
        while (line[i] === "`") {
          out += "\\`"
          i++
        }
        continue
      }
      case "<": {
        const match = inUrl ? null : autolink.exec(line.slice(i))
        if (match !== null && /^(?:https?|mailto)$/i.test(match[1]) && node(1)) {
          out += match[0]
          i += match[0].length
        } else {
          out += "&lt;"
          i++
        }
        continue
      }
      case "$":
        out += "\\$"
        i++
        continue
      case "=":
        out += context.setext ? "=" : "\\="
        i++
        continue
      case "|":
        out += context.tableRow && !context.widePipes ? "|" : "\\|"
        i++
        continue
      case "!":
        out += next === "[" ? "\\!" : "!"
        i++
        continue
      case "[":
        // A footnote reference, unless it opens the line's footnote definition.
        if (next === "^" && !(footnote && i === prefix.rest)) {
          if (context.footnotes.count >= maxFootnoteReferences || !node(footnoteNodes)) {
            out += "\\["
            i++
            continue
          }
          context.footnotes.count++
          opener = undefined
        } else if (!inUrl) {
          // Each `[` that could open a link or a reference counts as a node.
          if (!node(1)) {
            out += "\\["
            i++
            continue
          }
          opener = i
        }
        unclosed.push(out.length)
        out += "["
        i++
        continue
      case "]": {
        // Telegram closes a link at `]` even when it is escaped, so a refused
        // link loses its `(`. A kept destination is sent verbatim, which is
        // inert only if it is read as one: a link needs an opener on its
        // line, and not `[a][b](…)` or `[a][](…)`, where `[a]` may be the link.
        const plain = opener !== undefined && line[opener - 1] !== "]"
        const labelOpener = opener
        opener = undefined
        unclosed.pop()
        if (next === "(") {
          const tail = linkTail(line, i + 1)
          if (plain && tail !== undefined && allowedDestination(tail.destination, context.mentions)) {
            out += "](" + destinationOf(tail.destination) + ")"
            i = tail.end
            continue
          }
          out += "]\\("
          i += 2
          continue
        }
        // The `[` at the line's start counted as a node, so it is still a label.
        if (definition !== undefined && i === definition.close && labelOpener === prefix.rest) {
          context.definitions.allowed = true
          return out + "]: " + destinationOf(definition.destination)
        }
        out += "]"
        i++
        continue
      }
      case "*":
      case "_":
      case "~": {
        let end = i
        while (line[end] === c) end++
        const run = line.slice(i, end)
        const after = line[end]
        const spaced = (ch: string | undefined) => ch === undefined || ch === " " || ch === "\t"
        // A run with space on both sides is text to CommonMark, but Telegram
        // opens emphasis with it: `2 * 3 * 4` (live check 2).
        if (spaced(i === prefix.rest ? undefined : line[i - 1]) && spaced(after) && !thematicBreak.test(line)) {
          out += run.split("").map((char) => "\\" + char).join("")
          i = end
          continue
        }
        // A run of n delimiters can open n levels: `***a*b*c*` is three.
        // One followed by a space or the line's end can't open.
        if (!spaced(after)) {
          if (inline.open + run.length > limit) {
            out += run.split("").map((char) => "\\" + char).join("")
            i = end
            continue
          }
          inline.open += run.length
        }
        out += run
        i = end
        continue
      }
      default:
        out += c
        i++
    }
  }
  // A label left open at the start of a line could close on a later one,
  // as a definition's.
  if (label !== undefined && unclosed[0] === label) out = out.slice(0, label) + "\\" + out.slice(label)
  return out
}

/** @internal */
export interface RenderOptions {
  /** User ids whose `[name](tg://user?id=…)` links may stay. */
  readonly mentions?: ReadonlySet<string> | undefined
  /** How many files the post references at the end. */
  readonly files?: number | undefined
}

/**
 * Consumer Markdown as rich Markdown that keeps to what `measure` charged:
 *
 * - Fences pass verbatim, as do code spans, which are found left to right
 *   as CommonMark finds them. A fence indented by one to three spaces after
 *   a list item could belong to it, so from such a fence on nothing is
 *   verbatim. Inside a bare URL a backtick opens no span.
 * - `<` becomes `&lt;` unless it opens an http, https or mailto autolink,
 *   so there is no raw HTML, also after a bare URL, which would take a
 *   backslash with it. `$` and `=` are escaped (math, marks), except `=`
 *   under a paragraph of plain top-level lines (a setext heading), as is `|` outside tables
 *   (spoilers), and `!` before `[` (images).
 * - A backslash escape Telegram ignores becomes a numeric character
 *   reference, so `\<` is no HTML and `\]` closes no link.
 * - A link or reference definition whose destination, decoded as a
 *   Markdown parser and then a URL parser would, is not http, https or
 *   mailto is text: a link loses its `(`, a definition its opening `[`.
 *   A `tg://user` link stays for an id in `mentions`. A kept link needs its
 *   `[` and its whole tail on its line, a label with no other bracket in
 *   it, and no `]` right before it. A line whose first `[` meets a `]:`
 *   is a definition to Telegram, and is kept only at the top level after
 *   a blank line or another definition, with a label that starts the
 *   line, holds no other bracket, code span, autolink or escaped `]`, is
 *   not blank or a footnote's and is at most 999 characters, and with
 *   nothing after its destination but a title. Otherwise its `[` is
 *   escaped. Either needs balanced parentheses and no control character
 *   in its destination. Its destination is sent as Telegram reads it,
 *   verbatim, and its title is dropped.
 * - A `*`, `_` or `~` run with space on both sides is escaped, outside a
 *   thematic break: Telegram would open emphasis with it.
 * - Code spans, `[` that could open a link or reference, and footnote
 *   references past `maxInlineNodes` in a paragraph, or footnote
 *   references past `maxFootnoteReferences` in the message, are text. A
 *   `[` that starts a line and is not closed on it is escaped, as it could
 *   open a definition whose label ends on a later line.
 * - Container markers and emphasis past 16 levels are escaped. Every
 *   delimiter that could open emphasis counts as a level until the
 *   paragraph ends, at a blank line or a line that surely starts a block,
 *   and a lazy continuation line keeps the paragraph's container depth.
 * - A table keeps its pipes only when its header is at the start of a line
 *   after a blank line, a heading or the start of the text, where it can
 *   be no paragraph's continuation. A table wider than 20 columns has its
 *   pipes escaped. A table ends at a line that may start another block.
 * - `files` references are added at the end, after closing a fence left
 *   open.
 *
 * @internal
 */
export const render = (markdown: string, options: RenderOptions = {}): string => {
  const mentions = options.mentions ?? new Set<string>()
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/\0/g, "\ufffd").split("\n")
  const fenced: Array<boolean> = []
  let fence: Fence | undefined
  let containers = false
  let verbatim = true
  for (const line of lines) {
    if (fence !== undefined) {
      fenced.push(true)
      if (closes(line, fence)) fence = undefined
      continue
    }
    const opened = verbatim ? opens(line) : undefined
    if (opened !== undefined && opened.indent > 0 && containers) verbatim = false
    else if (opened !== undefined) {
      fence = opened
      fenced.push(true)
      continue
    }
    if (container.test(line)) containers = true
    fenced.push(false)
  }
  const tableRows = new Map<number, boolean>()
  const cellLines = new Set<number>()
  for (let i = 0; i + 1 < lines.length; i++) {
    if (fenced[i] || fenced[i + 1] || tableRows.has(i) || blockStart.test(lines[i])) continue
    // Neither row indented, nor the header after a line it could continue.
    if (/^\s/.test(lines[i]) || /^\s/.test(lines[i + 1])) continue
    const above = i === 0 ? "" : lines[i - 1]
    if (!isBlank(above) && !/^#{1,6}(?: |$)/.test(above)) continue
    if (!delimiterRow.test(lines[i + 1]) || !lines[i + 1].includes("|") || !hasPipe(lines[i])) continue
    // A delimiter row that is also a list item ends the paragraph first.
    if (/^ {0,3}-[ \t]+\S/.test(lines[i + 1])) continue
    const columns = cellCount(lines[i])
    if (columns !== cellCount(lines[i + 1])) continue
    let end = i + 2
    while (end < lines.length && !fenced[end] && !isBlank(lines[end]) && !blockStart.test(lines[end])) end++
    const rows = Array.from({ length: end - i }, (_, k) => i + k)
    for (const row of rows) tableRows.set(row, columns > maxColumns || cellCount(lines[row]) > maxColumns)
    // GFM ends a table at fewer lines than `blockStart` names, so a line
    // past its rows here may still be one of its rows there.
    for (let k = end; k < lines.length && !fenced[k] && !isBlank(lines[k]); k++) cellLines.add(k)
    i = end - 1
  }
  const inline: Inline = { open: 0, containers: 0, nodes: 0 }
  const footnotes = { count: 0 }
  const definitions = { allowed: true }
  let item: string | undefined
  // Whether every line since the last blank one is plain text at the top
  // level: no container, definition, table or other block that a `=` under
  // it could be the lazy continuation of.
  let plain = true
  const out = lines.map((line, i) => {
    const blank = isBlank(line)
    const setext = plain && i > 0 && !isBlank(lines[i - 1]) && /^ {0,3}=+[ \t]*$/.test(line)
    plain = !fenced[i] && (blank || (plain && !/^\s/.test(line) && !blockStart.test(line) && !line.includes("|")))
    if (fenced[i]) {
      definitions.allowed = false
      return line
    }
    const wide = tableRows.get(i)
    const starts = blank ? undefined : startsBlock(line, item)
    item = typeof starts === "string" ? starts : undefined
    if (blank || starts !== undefined || wide !== undefined) {
      inline.open = 0
      inline.containers = 0
      inline.nodes = 0
    }
    const rendered = renderLine(line, {
      tableRow: wide !== undefined,
      cells: wide !== undefined || cellLines.has(i),
      widePipes: wide === true,
      setext,
      inline,
      mentions,
      footnotes,
      definitions
    })
    if (blank) definitions.allowed = true
    return rendered
  })
  let text = out.join("\n")
  const files = options.files ?? 0
  if (files > 0) {
    if (fence !== undefined) text += "\n" + fence.char.repeat(fence.length)
    for (let n = 1; n <= files; n++) text += mediaReference(n)
  }
  return text
}

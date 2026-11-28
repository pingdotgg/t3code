/**
 * Renders a message's `rich_text` blocks as Markdown, for the `text` of the
 * bot's own messages. Slack stores the adapter's `markdown` block as
 * `rich_text`, and the stored `text` is the adapter's `text`, which may be
 * cut. Rendering the blocks gives the whole message back, with its newlines.
 *
 * The renderer is total: an element it does not know gives its `text`, or
 * nothing.
 */
import type { Mention } from "effect/chat/ChatMessage"
import { isObject } from "effect/Predicate"
import * as Emoji from "./emoji.ts"

type JsonObject = { readonly [key: string]: unknown }

const stringOf = (object: JsonObject, key: string): string | undefined => {
  const value = object[key]
  return typeof value === "string" ? value : undefined
}

const elementsOf = (object: JsonObject): ReadonlyArray<unknown> => Array.isArray(object.elements) ? object.elements : []

/** @internal */
export const hasRichText = (blocks: unknown): boolean =>
  Array.isArray(blocks) && blocks.some((block) => isObject(block) && block.type === "rich_text")

interface Style {
  readonly bold: boolean
  readonly italic: boolean
  readonly strike: boolean
  readonly code: boolean
}

const plain: Style = { bold: false, italic: false, strike: false, code: false }

const styleOf = (element: JsonObject): Style => {
  const style = element.style
  if (!isObject(style)) return plain
  return {
    bold: style.bold === true,
    italic: style.italic === true,
    strike: style.strike === true,
    code: style.code === true
  }
}

const sameStyle = (a: Style, b: Style) =>
  a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code

const opening = (style: Style): string =>
  (style.bold ? "**" : "") + (style.italic ? "*" : "") + (style.strike ? "~~" : "")

const closing = (style: Style): string =>
  (style.strike ? "~~" : "") + (style.italic ? "*" : "") + (style.bold ? "**" : "")

const longestRun = (text: string, char: string): number => {
  let longest = 0
  let run = 0
  for (const c of text) {
    run = c === char ? run + 1 : 0
    if (run > longest) longest = run
  }
  return longest
}

/** One element's content: plain text, or a mention token. */
type Piece =
  | { readonly _tag: "text"; readonly text: string; readonly markdown?: true }
  | { readonly _tag: "mention"; readonly token: string; readonly kind: Mention["kind"]; readonly id: string }

const emojiText = (element: JsonObject): string => {
  const unicode = stringOf(element, "unicode")
  if (unicode !== undefined && /^[0-9a-f]+(-[0-9a-f]+)*$/i.test(unicode)) {
    const points = unicode.split("-").map((hex) => parseInt(hex, 16))
    if (points.every((point) => point <= 0x10ffff)) return String.fromCodePoint(...points)
  }
  const name = stringOf(element, "name")
  if (name === undefined) return ""
  const tone = element.skin_tone
  const full = typeof tone === "number" ? `${name}::skin-tone-${tone}` : name
  return Emoji.fromName(full) ?? Emoji.fromName(name) ?? `:${full}:`
}

/** CommonMark accepts unescaped parentheses in a destination only when they nest in pairs. */
const linkDestination = (url: string): string => {
  let depth = 0
  for (const char of url) {
    if (char === "(") depth++
    if (char === ")" && --depth < 0) break
  }
  return depth === 0 ? url : url.replace(/[()\\]/g, "\\$&")
}

const pieceOf = (element: JsonObject, inCode: boolean): Piece => {
  switch (element.type) {
    case "text":
      return { _tag: "text", text: stringOf(element, "text") ?? "" }
    case "link": {
      const url = stringOf(element, "url") ?? ""
      const text = stringOf(element, "text")
      // Slack stores a bare URL as a link whose text is the URL without its scheme.
      const bare = text === undefined || text === "" || text === url ||
        text === url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      return {
        _tag: "text",
        text: bare ? url : `[${escapeInline(text)}](${inCode ? url : linkDestination(url)})`,
        markdown: true
      }
    }
    case "user": {
      const id = stringOf(element, "user_id")
      if (id !== undefined) return { _tag: "mention", token: `<@${id}>`, kind: "user", id }
      break
    }
    case "usergroup": {
      const id = stringOf(element, "usergroup_id")
      if (id !== undefined) return { _tag: "mention", token: `<!subteam^${id}>`, kind: "role", id }
      break
    }
    case "channel": {
      const id = stringOf(element, "channel_id")
      if (id !== undefined) return { _tag: "mention", token: `<#${id}>`, kind: "channel", id }
      break
    }
    case "broadcast": {
      const id = stringOf(element, "range")
      if (id !== undefined) return { _tag: "mention", token: `<!${id}>`, kind: "broadcast", id }
      break
    }
    case "emoji":
      return { _tag: "text", text: emojiText(element) }
    case "date":
      return { _tag: "text", text: stringOf(element, "fallback") ?? "" }
    case "color":
      return { _tag: "text", text: stringOf(element, "value") ?? "" }
  }
  return { _tag: "text", text: stringOf(element, "text") ?? "" }
}

const pieceText = (piece: Piece): string => piece._tag === "text" ? piece.text : piece.token

const wordChar = /[\p{L}\p{N}]/u
const asciiPunctuation = /[!-/:-@[-`{-~]/

/**
 * Backslash-escapes what Markdown would read as inline syntax, so a text
 * element's `*literal*` reads back literal. An underscore between two
 * letters or digits opens nothing and is left alone, as is a backslash
 * before anything but punctuation or a line end. `<` and `&` are left
 * alone: the adapter sends them as literal text either way.
 */
const escapeInline = (text: string): string =>
  text.replace(/[*_`~[\]\\]/g, (char, at: number) => {
    const before = text[at - 1] ?? ""
    const after = text[at + 1] ?? ""
    if (char === "_" && wordChar.test(before) && wordChar.test(after)) return char
    if (char === "\\" && after !== "" && after !== "\n" && !asciiPunctuation.test(after)) return char
    return "\\" + char
  })

/** A line start that would open a heading, list or quote, or underline the line before it. */
const blockStart = /^( {0,3})(?:([#]{1,6}|[-+])(?=[ \t]|$)|(>)|(\d{1,9})([.)])(?=[ \t]|$)|([-=])(?=[-= \t]*$))/

const escapeLineStart = (line: string): string =>
  line.replace(
    blockStart,
    (_, indent: string, marker?: string, quote?: string, digits?: string, delimiter?: string, rule?: string) =>
      marker !== undefined
        ? indent + "\\" + marker
        : quote !== undefined
        ? indent + "\\>"
        : digits !== undefined
        ? indent + digits + "\\" + delimiter
        : indent + "\\" + rule
  )

/** A text element's content as Markdown that reads back as the same text. */
const literal = (text: string, atLineStart: boolean): string =>
  escapeInline(text)
    .split("\n")
    .map((line, index) => index > 0 || atLineStart ? escapeLineStart(line) : line)
    .join("\n")

/**
 * Markdown that renders `text` as written, as the start of a message.
 *
 * @internal
 */
export const escapeMarkdown = (text: string): string => literal(text, true)

interface Writer {
  out: string
  readonly mentions: Array<Mention>
  readonly botUserId: string
}

const write = (writer: Writer, text: string): void => {
  writer.out += text
}

/** Writes a piece outside code: a link as built, other text escaped, a mention as its token. */
const writePiece = (writer: Writer, piece: Piece, text = pieceText(piece)): void => {
  if (piece._tag === "mention") return mention(writer, piece)
  if (piece.markdown === true) return write(writer, text)
  write(writer, literal(text, writer.out === "" || writer.out.endsWith("\n")))
}

const mention = (writer: Writer, piece: Extract<Piece, { _tag: "mention" }>): void => {
  const start = writer.out.length
  writer.out += piece.token
  writer.mentions.push({
    kind: piece.kind,
    id: piece.id,
    start,
    end: writer.out.length,
    isSelf: piece.kind === "user" && piece.id === writer.botUserId
  })
}

/** Starts a new line unless the output is empty or already ends one. */
const newline = (writer: Writer): void => {
  if (writer.out !== "" && !writer.out.endsWith("\n")) writer.out += "\n"
}

/**
 * Inline elements, grouped into runs of one style so markers wrap a run and
 * not each element. Whitespace at either end of a styled run goes outside
 * its markers, where Markdown needs it. Code is a span, and a token in it is
 * a literal.
 */
const inline = (writer: Writer, elements: ReadonlyArray<unknown>): void => {
  const items = elements.filter(isObject).map((element) => {
    const style = styleOf(element)
    return { piece: pieceOf(element, style.code), style }
  })
  let i = 0
  while (i < items.length) {
    const style = items[i].style
    let j = i + 1
    while (j < items.length && sameStyle(items[j].style, style)) j++
    const run = items.slice(i, j).map((item) => item.piece)
    i = j
    if (style.code) {
      const content = run.map(pieceText).join("")
      const fence = "`".repeat(longestRun(content, "`") + 1)
      // A backtick at either end would join the fence, and Markdown strips
      // one space from each end of a span that starts and ends with one.
      const pad = content.startsWith("`") || content.endsWith("`") ||
          (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "")
        ? " "
        : ""
      write(writer, opening(style) + fence + pad + content + pad + fence + closing(style))
      continue
    }
    const open = opening(style)
    if (open === "") {
      for (const piece of run) writePiece(writer, piece)
      continue
    }
    const first = run[0]
    const last = run[run.length - 1]
    const lead = first._tag === "text" ? /^\s*/.exec(first.text)![0] : ""
    const trail = last._tag === "text" ? /\s*$/.exec(last.text)![0] : ""
    if (run.length === 1 && first._tag === "text" && lead.length === first.text.length) {
      writePiece(writer, first)
      continue
    }
    write(writer, lead + open)
    run.forEach((piece, k) => {
      let text = pieceText(piece)
      if (k === 0) text = text.slice(lead.length)
      if (k === run.length - 1) text = text.slice(0, text.length - trail.length)
      writePiece(writer, piece, text)
    })
    write(writer, closing(style) + trail)
  }
}

/** Prefixes each line written since `from`, and moves the mentions in it to match. */
const prefixLines = (writer: Writer, from: number, first: string, rest: string): void => {
  const body = writer.out.slice(from)
  const lines = body.split("\n")
  let rewritten = ""
  const shifts: Array<readonly [number, number]> = []
  let position = from
  lines.forEach((line, index) => {
    const prefix = index === 0 ? first : rest
    shifts.push([position, prefix.length])
    rewritten += (index === 0 ? "" : "\n") + prefix + line
    position += line.length + 1
  })
  writer.out = writer.out.slice(0, from) + rewritten
  // Adjust mention offsets for inserted prefixes.
  for (let m = 0; m < writer.mentions.length; m++) {
    const mention = writer.mentions[m]
    if (mention.start < from) continue
    let shift = 0
    for (const [at, length] of shifts) if (at <= mention.start) shift += length
    writer.mentions[m] = { ...mention, start: mention.start + shift, end: mention.end + shift }
  }
}

const block = (writer: Writer, element: unknown): void => {
  if (!isObject(element)) return
  switch (element.type) {
    case "rich_text_section":
      return inline(writer, elementsOf(element))
    case "rich_text_preformatted": {
      // A fence holds no mention: every token is literal.
      const content = elementsOf(element).filter(isObject).map((child) => pieceText(pieceOf(child, true))).join("")
      const fence = "`".repeat(Math.max(3, longestRun(content, "`") + 1))
      write(writer, fence + "\n" + content + (content.endsWith("\n") ? "" : "\n") + fence)
      return
    }
    case "rich_text_quote": {
      const from = writer.out.length
      inline(writer, elementsOf(element))
      return prefixLines(writer, from, "> ", "> ")
    }
    case "rich_text_list": {
      const indent = "  ".repeat(typeof element.indent === "number" ? Math.max(0, element.indent) : 0)
      const ordered = element.style === "ordered"
      const offset = typeof element.offset === "number" ? element.offset : 0
      elementsOf(element).forEach((item, index) => {
        if (index > 0) write(writer, "\n")
        const marker = ordered ? `${offset + index + 1}. ` : "- "
        const from = writer.out.length
        block(writer, item)
        prefixLines(writer, from, indent + marker, indent + " ".repeat(marker.length))
      })
      return
    }
  }
  const text = stringOf(element, "text")
  if (text !== undefined) write(writer, text)
}

/**
 * The Markdown of a message's blocks, with the mentions at the offsets the
 * renderer wrote. A mention is a `user`, `usergroup`, `channel` or
 * `broadcast` element outside code. Blocks other than `rich_text` give
 * their `text` when it is a string, and nothing otherwise.
 *
 * @internal
 */
export const render = (blocks: ReadonlyArray<unknown>, botUserId: string): {
  readonly text: string
  readonly mentions: ReadonlyArray<Mention>
} => {
  const writer: Writer = { out: "", mentions: [], botUserId }
  for (const item of blocks) {
    if (!isObject(item)) continue
    if (item.type === "rich_text") {
      for (const element of elementsOf(item)) {
        newline(writer)
        block(writer, element)
      }
    } else {
      const text = stringOf(item, "text")
      if (text !== undefined && text !== "") {
        newline(writer)
        write(writer, text)
      }
    }
  }
  return { text: writer.out, mentions: writer.mentions }
}

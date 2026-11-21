/**
 * Markdown to WhatsApp text.
 *
 * Each construct the renderer knows has a candidate replacement, rendered
 * bottom-up, which is emitted only when it is no longer than the
 * construct's source in code points, UTF-16 units and UTF-8 bytes. Otherwise
 * the source is emitted as it is. Text between constructs is always kept, so
 * the output is never longer than the input in any of the three units.
 */

/**
 * The longest text message, and the measure's unit: UTF-16 code units, which
 * are never fewer than the code points Meta counts. @internal
 */
export const messageLength = 4096

/** The longest caption, and the longest body beside reply buttons or a link button. @internal */
export const shortBodyLength = 1024

/** @internal */
export const measure = (markdown: string): number => markdown.length

const codePoints = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** @internal */
export const utf8Bytes = (s: string): number => {
  let n = 0
  for (const char of s) {
    const code = char.codePointAt(0)!
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return n
}

/** Whether `candidate` is no longer than `source` in all three units. @internal */
export const fits = (candidate: string, source: string): boolean =>
  candidate.length <= source.length && codePoints(candidate) <= codePoints(source) &&
  utf8Bytes(candidate) <= utf8Bytes(source)

const pick = (candidate: string, source: string): string => fits(candidate, source) ? candidate : source

/** The characters WhatsApp formats with, which a decoded reference must not produce. */
const formatting = new Set(["*", "_", "~", "`"])

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  minus: "−",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  lArr: "⇐",
  rArr: "⇒",
  hArr: "⇔",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  iexcl: "¡",
  iquest: "¿"
}

const decodeReference = (reference: string): string | undefined => {
  const body = reference.slice(1, -1)
  let decoded: string | undefined
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X"
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10)
    decoded = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code)
  } else {
    decoded = Object.hasOwn(entities, body) ? entities[body] : undefined
  }
  return decoded === undefined || formatting.has(decoded) ? undefined : decoded
}

const isWhitespace = (char: string | undefined) => char === undefined || /\s/u.test(char)
const isPunctuation = (char: string | undefined) => char !== undefined && /[\p{P}\p{S}]/u.test(char)
const isAsciiPunctuation = (char: string | undefined) => char !== undefined && /[!-/:-@[-`{-~]/.test(char)

interface Atom {
  readonly end: number
  readonly text: string
}

const runLength = (s: string, i: number, char: string) => {
  let j = i
  while (s[j] === char) j++
  return j - i
}

/** A code span from the backtick run at `i`, or the run itself when it has no match. */
const codeSpan = (s: string, i: number): Atom => {
  const n = runLength(s, i, "`")
  let j = i + n
  while (j < s.length) {
    if (s[j] !== "`") {
      j++
      continue
    }
    const m = runLength(s, j, "`")
    if (m === n) return { end: j + m, text: s.slice(i, j + m) }
    j += m
  }
  return { end: i + n, text: s.slice(i, i + n) }
}

const autolink = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/
const emailAutolink =
  /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/
const html = /^(?:<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>)/
const reference = /^&(?:#[0-9]{1,7};|#[xX][0-9A-Fa-f]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/

/** The index of the `]` closing the `[` at `i`, skipping escapes and code spans. */
const closeBracket = (s: string, i: number): number => {
  let depth = 0
  let j = i
  while (j < s.length) {
    const char = s[j]
    if (char === "\\") j += 2
    else if (char === "`") j = codeSpan(s, j).end
    else {
      if (char === "[") depth++
      else if (char === "]" && --depth === 0) return j
      j++
    }
  }
  return -1
}

/** An inline destination and optional title from the `(` at `i`: the URL and the index after `)`. */
const destination = (s: string, i: number): { readonly url: string; readonly end: number } | undefined => {
  let j = i + 1
  while (s[j] === " " || s[j] === "\t") j++
  let url: string
  if (s[j] === "<") {
    const close = s.indexOf(">", j)
    if (close < 0 || s.slice(j + 1, close).includes("<")) return undefined
    url = s.slice(j + 1, close)
    j = close + 1
  } else {
    const start = j
    let depth = 0
    while (j < s.length && !/\s/.test(s[j])) {
      if (s[j] === "\\" && isAsciiPunctuation(s[j + 1])) j++
      else if (s[j] === "(") depth++
      else if (s[j] === ")") {
        if (depth === 0) break
        depth--
      }
      j++
    }
    if (depth !== 0) return undefined
    url = s.slice(start, j)
  }
  const afterUrl = j
  while (s[j] === " " || s[j] === "\t") j++
  if (j > afterUrl && (s[j] === "\"" || s[j] === "'" || s[j] === "(")) {
    const close = s[j] === "(" ? ")" : s[j]
    let k = j + 1
    while (k < s.length && s[k] !== close) k += s[k] === "\\" ? 2 : 1
    if (k >= s.length) return undefined
    j = k + 1
    while (s[j] === " " || s[j] === "\t") j++
  }
  return s[j] === ")" ? { url, end: j + 1 } : undefined
}

/** A link or image from the `[` at `i`, `start` being the `!` of an image. */
const link = (s: string, start: number, i: number): Atom | undefined => {
  if (s[i + 1] === "^") {
    const close = s.indexOf("]", i)
    return close < 0 ? undefined : { end: close + 1, text: s.slice(start, close + 1) }
  }
  const close = closeBracket(s, i)
  if (close < 0) return undefined
  if (s[close + 1] === "[") {
    const end = s.indexOf("]", close + 1)
    return end < 0 ? undefined : { end: end + 1, text: s.slice(start, end + 1) }
  }
  // A shortcut reference, or plain brackets: either way it is kept as typed.
  const verbatim = { end: close + 1, text: s.slice(start, close + 1) }
  if (s[close + 1] !== "(") return verbatim
  const target = destination(s, close + 1)
  if (target === undefined) return verbatim
  const label = s.slice(i + 1, close)
  const shown = start < i ? label : inline(label)
  const candidate = label === "" || label === target.url ? target.url : shown + " (" + target.url + ")"
  return { end: target.end, text: pick(candidate, s.slice(start, target.end)) }
}

/** The construct at `i` that is kept or replaced as a whole, if any. */
const atom = (s: string, i: number): Atom | undefined => {
  switch (s[i]) {
    case "\\":
      return isAsciiPunctuation(s[i + 1]) ? { end: i + 2, text: s.slice(i, i + 2) } : undefined
    case "`":
      return codeSpan(s, i)
    case "<": {
      const rest = s.slice(i)
      const match = autolink.exec(rest) ?? emailAutolink.exec(rest)
      if (match !== null) return { end: i + match[0].length, text: pick(match[1], match[0]) }
      const tag = html.exec(rest)
      return tag === null ? undefined : { end: i + tag[0].length, text: tag[0] }
    }
    case "!":
      return s[i + 1] === "[" ? link(s, i, i + 1) : undefined
    case "[":
      return link(s, i, i)
    case "&": {
      const match = reference.exec(s.slice(i, i + 40))
      if (match === null) return undefined
      const decoded = decodeReference(match[0])
      return { end: i + match[0].length, text: decoded === undefined ? match[0] : pick(decoded, match[0]) }
    }
  }
  return undefined
}

const leftFlanking = (before: string | undefined, after: string | undefined) =>
  !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before))

const rightFlanking = (before: string | undefined, after: string | undefined) =>
  !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after))

const canOpen = (s: string, i: number, n: number) => {
  const before = s[i - 1]
  const after = s[i + n]
  const left = leftFlanking(before, after)
  return s[i] === "_" ? left && (!rightFlanking(before, after) || isPunctuation(before)) : left
}

const canClose = (s: string, i: number, n: number) => {
  const before = s[i - 1]
  const after = s[i + n]
  const right = rightFlanking(before, after)
  return s[i] === "_" ? right && (!leftFlanking(before, after) || isPunctuation(after)) : right
}

/** Emphasis or strikethrough from the delimiter run at `i`, if it has a closer. */
const emphasis = (s: string, i: number): Atom | undefined => {
  const char = s[i]
  const n = runLength(s, i, char)
  if (n > 2 || !canOpen(s, i, n)) return undefined
  let j = i + n
  while (j < s.length) {
    const skipped = s[j] === "*" || s[j] === "_" || s[j] === "~" ? undefined : atom(s, j)
    if (skipped !== undefined) {
      j = skipped.end
      continue
    }
    if (s[j] !== char) {
      j++
      continue
    }
    const m = runLength(s, j, char)
    if (m === n && j > i + n && canClose(s, j, m)) {
      const marker = char === "~" ? "~" : n === 2 ? "*" : "_"
      const candidate = marker + inline(s.slice(i + n, j)) + marker
      return { end: j + m, text: pick(candidate, s.slice(i, j + m)) }
    }
    j += m
  }
  return undefined
}

/** One line of inline Markdown. @internal */
export const inline = (s: string): string => {
  let out = ""
  let i = 0
  while (i < s.length) {
    const char = s[i]
    const found = char === "*" || char === "_" || char === "~" ? emphasis(s, i) : atom(s, i)
    if (found !== undefined) {
      out += found.text
      i = found.end
    } else if (char === "*" || char === "_" || char === "~") {
      const n = runLength(s, i, char)
      out += s.slice(i, i + n)
      i += n
    } else {
      out += char
      i++
    }
  }
  return out
}

const fenceOpen = /^( {0,3})(`{3,}|~{3,})(.*)$/
const atxHeading = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/
const thematicBreak = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const definition = /^ {0,3}\[[^\]]+\]:/
const blockStart = /^(?: {4}|\t| {0,3}(?:[>#|]|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|`{3}|~{3}))/
const tableDelimiter = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const quoteMarker = /^ {0,3}>[ \t]?/
const listMarker = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))([ \t]+|$)/

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length

const isBlank = (line: string) => line.trim() === ""

/**
 * The quotes and list items a line opens, outermost first, and the rest of
 * the line. A quote is 0, and a list item the indentation its content needs.
 */
const containers = (line: string): { readonly stack: ReadonlyArray<number>; readonly rest: string } => {
  const stack: Array<number> = []
  let rest = line
  while (true) {
    const quote = quoteMarker.exec(rest)
    if (quote !== null) {
      stack.push(0)
      rest = rest.slice(quote[0].length)
      continue
    }
    const item = listMarker.exec(rest)
    if (item === null || thematicBreak.test(rest)) break
    // Five spaces or more after the marker start indented code, whose content starts after one.
    const width = item[2] === "" || item[2].length >= 5 ? item[1].length + 1 : item[0].length
    stack.push(width)
    rest = rest.slice(Math.min(width, item[0].length))
  }
  return { stack, rest }
}

/**
 * A line with the tabs of its indentation and container markers expanded to
 * the next multiple of four columns, so a tab only partly taken by a
 * container leaves its other columns. Used to find blocks, never as output.
 */
const expandIndent = (line: string): string => {
  let out = ""
  for (let k = 0; k < line.length; k++) {
    const char = line[k]
    if (char === "\t") out += " ".repeat(4 - (out.length % 4))
    else if (/[ >\-*+.)0-9]/.test(char)) out += char
    else return out + line.slice(k)
  }
  return out
}

/**
 * What is left of a line, with its indentation expanded, inside the
 * containers of `stack`, or `undefined` when the line ends one of them.
 */
const inside = (line: string, stack: ReadonlyArray<number>): string | undefined => {
  let rest = line
  for (const width of stack) {
    if (width === 0) {
      const quote = quoteMarker.exec(rest)
      if (quote === null) return undefined
      rest = rest.slice(quote[0].length)
      continue
    }
    if (isBlank(rest)) return ""
    if (!rest.startsWith(" ".repeat(width))) return undefined
    rest = rest.slice(width)
  }
  return rest
}

/** Whether a line starts a block, which ends a definition or a table that was being kept as typed. */
const opensBlock = (line: string) =>
  fenceOpen.test(line) || atxHeading.test(line) || thematicBreak.test(line) || containers(line).stack.length > 0

/**
 * Markdown as WhatsApp text, never longer than the Markdown in code points,
 * UTF-16 units or UTF-8 bytes.
 *
 * @internal
 */
export const render = (markdown: string): string => {
  const lines = markdown.split(/(?<=\n)/)
  const body = (k: number) => lines[k].replace(/\r?\n$/, "")
  const eol = (k: number) => lines[k].slice(body(k).length)
  let out = ""
  let i = 0
  while (i < lines.length) {
    const line = body(i)
    const { rest, stack } = containers(expandIndent(line))
    const fence = fenceOpen.exec(rest)
    if (fence !== null && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      // The closer is matched inside the opener's quotes and list items. A line outside them ends the code too.
      const closing = new RegExp("^ {0,3}" + (fence[2][0] === "~" ? "~" : "`") + "{" + fence[2].length + ",}[ \\t]*$")
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        const code = inside(expandIndent(body(j)), stack)
        if (code === undefined) break
        if (closing.test(code)) {
          closed = true
          break
        }
      }
      if (!closed) {
        out += lines.slice(i, j).join("")
        i = j
        continue
      }
      const content = lines.slice(i + 1, j).join("")
      const source = lines.slice(i, j + 1).join("")
      const candidate = "```" + eol(i) + content + "```" + eol(j)
      out += stack.length > 0 || content.includes("```") ? source : pick(candidate, source)
      i = j + 1
      continue
    }
    if (definition.test(rest)) {
      // A destination or title may continue on the next lines, up to a blank line or the start of a block.
      out += lines[i]
      let j = i + 1
      while (j < lines.length) {
        const next = inside(expandIndent(body(j)), stack) ?? expandIndent(body(j))
        if (isBlank(next) || opensBlock(next)) break
        out += lines[j++]
      }
      i = j
      continue
    }
    if (i + 1 < lines.length && line.includes("|") && tableDelimiter.test(body(i + 1)) && body(i + 1).includes("|")) {
      if (cells(line) === cells(body(i + 1))) {
        out += lines[i]
        let j = i + 2
        while (j < lines.length && !isBlank(body(j)) && !opensBlock(expandIndent(body(j)))) out += lines[j++]
        i = j
        continue
      }
    }
    const heading = atxHeading.exec(line)
    if (heading !== null) {
      const content = (heading[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim()
      out += (content === "" ? line : pick("*" + inline(content) + "*", line)) + eol(i)
      i++
      continue
    }
    if (
      i + 1 < lines.length && !isBlank(line) && !blockStart.test(line) && !thematicBreak.test(line) &&
      !definition.test(line) && (i === 0 || isBlank(body(i - 1))) && setextUnderline.test(body(i + 1))
    ) {
      const source = line + eol(i) + body(i + 1)
      out += pick("*" + inline(line.trim()) + "*", source) + eol(i + 1)
      i += 2
      continue
    }
    // Indented code, measured inside its quotes and list items with tabs expanded, is kept as typed.
    if (/^ {4}/.test(rest) || thematicBreak.test(line)) {
      out += lines[i]
      i++
      continue
    }
    // The text is cut from the line as typed, so the output keeps its tabs.
    const text = containers(line).rest
    out += line.slice(0, line.length - text.length) + inline(text) + eol(i)
    i++
  }
  return out
}

/**
 * Renders Markdown as a Bot Framework activity for Teams. A message is sent
 * in one of two forms, never mixed: text, when it has no actions, and an
 * Adaptive Card, when it has.
 *
 * The renderer keeps to the rules that make `Length.measure` an upper
 * bound: a source line gives at most one element, a table row has at most
 * one cell more than it has pipes, each source unit is sent at most once,
 * and nothing is sent beyond the templates below and the source text.
 */
import type { Action, Button, LinkButton } from "effect/chat/ChatUi"
import { toWellFormed } from "effect/String"

/** @internal */
export const cardContentType = "application/vnd.microsoft.card.adaptive"

/**
 * The most actions in one `ActionSet` row: the number of actions Teams
 * shows in a row before it moves the rest into an overflow menu.
 *
 * @internal
 */
export const actionsPerRow = 6

/**
 * Escapes `<` and `&`, so that no HTML tag, `<at>` mention or entity
 * forms in text Teams reads as Markdown.
 *
 * @internal
 */
export const escapeText = (text: string): string => text.replace(/[<&]/g, (c) => c === "<" ? "&lt;" : "&amp;")

/** @internal */
export const textActivity = (markdown: string): Record<string, unknown> => ({
  type: "message",
  text: escapeDollars(escapeText(toWellFormed(markdown))),
  textFormat: "extendedmarkdown"
})

/** @internal */
export const textBlock = (text: string) => ({ type: "TextBlock", text, wrap: true })

/** @internal */
export const codeBlock = (codeSnippet: string, language: string) => ({ type: "CodeBlock", codeSnippet, language })

/** @internal */
export const column = { width: 1 }

/** @internal */
export const tableCell = (text: string) => ({ type: "TableCell", items: [textBlock(text)] })

/** @internal */
export const tableRow = (cells: ReadonlyArray<string>) => ({ type: "TableRow", cells: cells.map(tableCell) })

/** A table with one column for each cell of its widest row. @internal */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>) => ({
  type: "Table",
  firstRowAsHeaders: true,
  columns: Array.from({ length: Math.max(0, ...rows.map((row) => row.length)) }, () => column),
  rows: rows.map(tableRow)
})

/** @internal */
export const actionSet = (actions: ReadonlyArray<unknown>) => ({ type: "ActionSet", actions })

/** @internal */
export const card = (body: ReadonlyArray<unknown>) => ({
  type: "AdaptiveCard",
  version: "1.5",
  body,
  msteams: { width: "Full" }
})

/** @internal */
export const cardActivityOf = (body: ReadonlyArray<unknown>): Record<string, unknown> => ({
  type: "message",
  attachments: [{ contentType: cardContentType, content: card(body) }]
})

const styles = { primary: "positive", danger: "destructive" } as const

/**
 * `Action.Execute`, with `Action.Submit` as the fallback for clients
 * without Universal Actions. `token` carries the button's id and value.
 *
 * @internal
 */
export const buttonAction = (button: Button, token: string) => {
  const title = toWellFormed(button.label)
  const style = button.style === "primary" || button.style === "danger" ? { style: styles[button.style] } : {}
  return {
    type: "Action.Execute",
    title,
    verb: "effect",
    data: { effect: token },
    ...style,
    fallback: { type: "Action.Submit", title, data: { effect: token } }
  }
}

/**
 * A button that opens a dialog: an `Action.Submit` with `task/fetch`,
 * smaller than the `Action.Execute` and fallback the measure prices.
 *
 * @internal
 */
export const dialogAction = (button: Button, token: string) => ({
  type: "Action.Submit",
  title: toWellFormed(button.label),
  data: { msteams: { type: "task/fetch" }, effect: token }
})

/** @internal */
export const linkAction = (link: LinkButton) => ({
  type: "Action.OpenUrl",
  title: toWellFormed(link.label),
  url: toWellFormed(link.url)
})

/**
 * The card form. Selects are not rendered: the adapter refuses them first.
 *
 * @internal
 */
export const cardActivity = (
  markdown: string,
  actions: ReadonlyArray<Action>,
  encode: (button: Button) => string,
  opensDialog: (button: Button) => boolean = () => false
): Record<string, unknown> => {
  const body: Array<unknown> = blocks(markdown)
  const rendered: Array<unknown> = []
  for (const action of actions) {
    if (action._tag === "Button") {
      rendered.push(opensDialog(action) ? dialogAction(action, encode(action)) : buttonAction(action, encode(action)))
    } else if (action._tag === "LinkButton") rendered.push(linkAction(action))
  }
  for (let i = 0; i < rendered.length; i += actionsPerRow) {
    body.push(actionSet(rendered.slice(i, i + actionsPerRow)))
  }
  return cardActivityOf(body)
}

interface Fence {
  readonly indent: number
  readonly marker: string
  readonly language: string
}

const fenceOpen = (line: string): Fence | undefined => {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (match === null) return undefined
  const [, spaces, marker, info] = match
  if (marker[0] === "`" && info.includes("`")) return undefined
  const word = info.trim().split(/\s+/)[0]
  return { indent: spaces.length, marker, language: word === "" ? "PlainText" : word }
}

const stripFenceIndent = (line: string, indent: number): string => {
  let i = 0
  while (i < indent && line[i] === " ") i++
  // An opening fence is at most three columns in, so a tab crossed here ends at column four.
  if (i < indent && line[i] === "\t") return " ".repeat(4 - indent) + line.slice(i + 1)
  return line.slice(i)
}

const fenceCloses = (fence: Fence, line: string): boolean => {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return match !== null && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length
}

/**
 * Escapes each `$` outside code as `\$`, so that Teams reads no math in
 * the text form. A `$` the Markdown already escapes, after an odd run of
 * backslashes, is left alone, and so is code: fenced blocks and code spans
 * on one line. One unit per `$` at most, as `Length.weight` prices it.
 *
 * @internal
 */
export const escapeDollars = (markdown: string): string => {
  const parts = markdown.split(/(\r\n|\r|\n)/)
  let fence: Fence | undefined
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    if (fence !== undefined) {
      if (fenceCloses(fence, line)) fence = undefined
      continue
    }
    fence = fenceOpen(line)
    if (fence === undefined) parts[i] = escapeLine(line)
  }
  return parts.join("")
}

const escapeLine = (line: string): string => {
  let out = ""
  let i = 0
  while (i < line.length) {
    const char = line[i]
    if (char === "`") {
      let run = 1
      while (line[i + run] === "`") run++
      const ticks = "`".repeat(run)
      const close = findRun(line, ticks, i + run)
      const end = close === -1 ? i + run : close + run
      out += line.slice(i, end)
      i = end
      continue
    }
    if (char === "$") {
      let backslashes = 0
      while (line[i - 1 - backslashes] === "\\") backslashes++
      out += backslashes % 2 === 0 ? "\\$" : "$"
    } else out += char
    i++
  }
  return out
}

/** The index of a run of exactly `ticks` from `from`, or -1. */
const findRun = (line: string, ticks: string, from: number): number => {
  for (let at = line.indexOf(ticks, from); at !== -1; at = line.indexOf(ticks, at + 1)) {
    if (line[at - 1] !== "`" && line[at + ticks.length] !== "`") return at
  }
  return -1
}

const delimiterRow = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/

const isDelimiter = (line: string): boolean => line.includes("|") && delimiterRow.test(line)

/** The cells of a table row. There are never more than its pipes plus one. */
const cells = (line: string): Array<string> => {
  let row = line.trim()
  if (row.startsWith("|")) row = row.slice(1)
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map((cell) => escapeText(cell.trim().replace(/\\\|/g, "|")))
}

/**
 * One line of a paragraph, with the block syntax a TextBlock cannot show
 * taken off: quote markers and heading markers are dropped, and the first
 * list marker is kept. `> - # x` becomes `- x`.
 */
const flatten = (line: string): string => {
  let rest = line
  let marker = ""
  for (;;) {
    const quote = /^ {0,3}> ?/.exec(rest)
    if (quote !== null) {
      rest = rest.slice(quote[0].length)
      continue
    }
    if (marker === "") {
      const list = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(rest)
      if (list !== null) {
        marker = list[0]
        rest = rest.slice(marker.length)
        continue
      }
    }
    const heading = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(rest)
    if (heading !== null) {
      rest = rest.slice(heading[0].length)
      continue
    }
    return marker + rest
  }
}

/**
 * The card body for Markdown: `TextBlock`, `CodeBlock` and `Table`
 * elements in the order of the source. Consecutive lines of text share one
 * `TextBlock`, joined by `\n`.
 *
 * @internal
 */
export const blocks = (markdown: string): Array<unknown> => {
  const lines = toWellFormed(markdown).split(/\r\n|\r|\n/)
  const body: Array<unknown> = []
  let text: Array<string> = []
  const flush = () => {
    let start = 0
    let end = text.length
    while (start < end && text[start].trim() === "") start++
    while (end > start && text[end - 1].trim() === "") end--
    if (start < end) body.push(textBlock(escapeText(text.slice(start, end).join("\n"))))
    text = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = fenceOpen(line)
    if (fence !== undefined) {
      flush()
      const code: Array<string> = []
      i++
      while (i < lines.length && !fenceCloses(fence, lines[i])) code.push(stripFenceIndent(lines[i++], fence.indent))
      i++
      body.push(codeBlock(code.join("\n"), fence.language))
      continue
    }
    if (line.includes("|") && i + 1 < lines.length && isDelimiter(lines[i + 1])) {
      flush()
      const rows = [cells(line)]
      i += 2
      while (i < lines.length && lines[i].includes("|") && fenceOpen(lines[i]) === undefined) {
        rows.push(cells(lines[i++]))
      }
      body.push(table(rows))
      continue
    }
    text.push(flatten(line))
    i++
  }
  flush()
  return body
}

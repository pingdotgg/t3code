import type * as Mdast from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"

/** What a GFM parse of rendered Markdown holds that the renderer promises it never will. */
export interface Findings {
  readonly html: ReadonlyArray<string>
  readonly images: number
  readonly links: ReadonlyArray<string>
  readonly maxDepth: number
  readonly maxColumns: number
  readonly blocks: number
  /** Text that reached the parser with an unescaped `|`, `$` or `=`, Telegram's spoiler, math and mark syntax. */
  readonly active: ReadonlyArray<string>
  /**
   * Text holding a backslash escape Telegram does not honor, which it shows
   * as a backslash and then reads the character as syntax (live check 2).
   */
  readonly unhonored: ReadonlyArray<string>
  /**
   * The most inline nodes in one paragraph, as the renderer counts them:
   * code spans, links and references written with `[` or `<`, and footnote
   * references at three each. Bare URLs are not counted.
   */
  readonly inline: number
}

/** Punctuation whose backslash escape Telegram honors. */
const honored = /[!#$()*+\-.=>[\\_`{|}~]/

const nesting = new Set(["blockquote", "listItem", "emphasis", "strong", "delete"])
const blockTypes = new Set([
  "paragraph",
  "heading",
  "code",
  "thematicBreak",
  "listItem",
  "tableRow",
  "blockquote",
  "html"
])

export const inspect = (markdown: string): Findings => {
  const html: Array<string> = []
  const links: Array<string> = []
  let images = 0
  let maxDepth = 0
  let maxColumns = 0
  let blocks = 0
  const active: Array<string> = []
  const unhonored: Array<string> = []
  let inline = 0
  /** The inline nodes under `node`, as `Findings.inline` counts them. */
  const count = (node: Mdast.Nodes): number => {
    const own = node.type === "inlineCode"
      ? 1
      : node.type === "footnoteReference"
      ? 3
      : (node.type === "link" || node.type === "linkReference") &&
          /[[<]/.test(markdown[node.position?.start.offset ?? -1] ?? "")
      ? 1
      : 0
    return "children" in node
      ? node.children.reduce((sum, child) => sum + count(child as Mdast.Nodes), own)
      : own
  }
  const visit = (node: Mdast.Nodes, depth: number) => {
    const d = nesting.has(node.type) ? depth + 1 : depth
    maxDepth = Math.max(maxDepth, d)
    if (blockTypes.has(node.type)) blocks++
    if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
      inline = Math.max(inline, count(node))
    }
    switch (node.type) {
      case "text": {
        if (node.position === undefined) break
        const source = markdown.slice(node.position.start.offset, node.position.end.offset)
        if (/(?:^|[^\\])(?:\\\\)*[|$=]/.test(source)) active.push(source)
        // One pass, so that an escape right after another is still seen.
        for (let i = 0; i < source.length; i++) {
          if (source[i] !== "\\") continue
          const next = source[++i]
          if (next !== undefined && /[!-/:-@[-`{-~]/.test(next) && !honored.test(next)) unhonored.push(source)
        }
        break
      }
      case "html":
        html.push(node.value)
        break
      case "image":
      case "imageReference":
        images++
        break
      case "link":
        links.push(node.url)
        // An autolink's text is its URL, which no parser reads as syntax.
        if (markdown[node.position?.start.offset ?? -1] === "<") return
        break
      case "definition":
        links.push(node.url)
        break
      case "table":
        for (const row of node.children) maxColumns = Math.max(maxColumns, row.children.length)
        break
    }
    if ("children" in node) { for (const child of node.children) visit(child as Mdast.Nodes, d) }
  }
  visit(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }), 0)
  return { html, images, links, maxDepth, maxColumns, blocks, active, unhonored, inline }
}

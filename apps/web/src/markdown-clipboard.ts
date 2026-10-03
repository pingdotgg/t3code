/**
 * Converts a DOM selection inside rendered chat markdown back into markdown
 * source so highlight-and-copy keeps formatting (links, emphasis, lists,
 * fences, tables) instead of flattening to plain text. The `text/plain`
 * clipboard flavor carries the markdown, with tables in the user's table copy
 * format; `text/html` carries a sanitized copy of the rendered fragment for
 * rich-paste targets.
 */

import type { TableCopyFormat } from "@t3tools/contracts";
import type { Nodes, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const SKIPPED_TAGS = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE"]);
const SKIPPED_CLASS_NAMES = ["select-none", "sr-only"];
const SANITIZED_HTML_SELECTOR = [
  "button",
  "input",
  "script",
  "style",
  "svg",
  '[aria-hidden="true"]',
  ...SKIPPED_CLASS_NAMES.map((className) => `.${className}`),
].join(", ");

export interface MarkdownClipboardPayload {
  text: string;
  html: string;
}

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName) || element.localName === "svg") return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  return SKIPPED_CLASS_NAMES.some((className) => element.classList.contains(className));
}

/** Hoists surrounding whitespace outside the markers: "` bold `" → " **bold** ". */
function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? "";
  if (!core) return content;
  return `${match?.[1] ?? ""}${marker}${core}${marker}${match?.[3] ?? ""}`;
}

/**
 * A code element whose pre wrapper fell outside the copied range is still
 * block code, recognizable by its highlighter line spans or embedded
 * newlines. Wrapping it like inline code produces backtick-surrounded
 * shell commands on paste.
 */
function isBlockCodeElement(element: Element, content: string): boolean {
  if (content.includes("\n")) return true;
  for (const child of element.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).classList.contains("line")) {
      return true;
    }
  }
  return false;
}

function wrapInlineCode(code: string): string {
  const longestRun = [...(code.match(/`+/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(1, longestRun + (longestRun > 0 ? 1 : 0)));
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function codeFenceFor(code: string): string {
  const longestRun = [...(code.match(/`{3,}/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function resolveCodeBlockLanguage(pre: Element): string | null {
  const declared =
    pre.closest("[data-language]")?.getAttribute("data-language") ??
    /(?:^|\s)language-(\S+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ??
    null;
  return declared && declared !== "text" ? declared : null;
}

function serializeCodeBlock(pre: Element): string {
  const code = (pre.textContent ?? "").replace(/\n$/, "");
  const fence = codeFenceFor(code);
  return `${fence}${resolveCodeBlockLanguage(pre) ?? ""}\n${code}\n${fence}\n\n`;
}

function serializeTableCell(cell: Element): string {
  return serializeChildren(cell).replace(/\n+/g, " ").trim().replaceAll("|", "\\|");
}

function tableSeparatorFor(headerCells: Element[]): string {
  const markers = headerCells.map((cell) => {
    const align = (cell as HTMLElement).style?.textAlign ?? cell.getAttribute("align") ?? "";
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  return `| ${markers.join(" | ")} |`;
}

function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];
  if (rows.length === 0) return "";
  const lines: string[] = [];
  let emittedSeparator = false;
  for (const row of rows) {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    if (cells.length === 0) continue;
    lines.push(`| ${cells.map((cell) => serializeTableCell(cell)).join(" | ")} |`);
    if (!emittedSeparator) {
      lines.push(tableSeparatorFor(cells));
      emittedSeparator = true;
    }
  }
  return `${lines.join("\n")}\n\n`;
}

function serializeListItem(item: Element, ordered: boolean, index: number): string {
  const checkbox = item.querySelector(
    ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
  );
  const task = checkbox ? `[${(checkbox as HTMLInputElement).checked ? "x" : " "}] ` : "";
  const marker = ordered ? `${index}. ${task}` : `- ${task}`;
  let content = serializeChildren(item)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Tight list items (no paragraph children) keep nested lists on adjacent lines.
  if (!item.querySelector(":scope > p")) {
    content = content.replace(/\n{2,}/g, "\n");
  }
  const continuationIndent = " ".repeat(marker.length);
  const [first = "", ...rest] = content.split("\n");
  return [
    `${marker}${first}`,
    ...rest.map((line) => (line.length > 0 ? `${continuationIndent}${line}` : line)),
  ].join("\n");
}

function serializeList(list: Element, ordered: boolean): string {
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const items = [...list.children].filter((child) => child.tagName === "LI");
  if (items.length === 0) return "";
  return `${items.map((item, index) => serializeListItem(item, ordered, start + index)).join("\n")}\n\n`;
}

function serializeBlockquote(quote: Element): string {
  const content = serializeChildren(quote)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!content) return "";
  const quoted = content
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

function serializeDetails(details: Element): string {
  const summary =
    details.querySelector(":scope > [data-markdown-details-summary]")?.textContent?.trim() ??
    "Details";
  const contentNode = details.querySelector(":scope > * [data-markdown-details-content]");
  const content = contentNode ? serializeChildren(contentNode).trim() : "";
  const open = details.getAttribute("data-markdown-details-open") === "true" ? " open" : "";
  return `<details${open}>\n<summary>${summary}</summary>${content ? `\n\n${content}` : ""}\n</details>\n\n`;
}

function serializeAnchor(anchor: Element): string {
  const markdownCopy = anchor.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return markdownCopy;
  const content = serializeChildren(anchor);
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return "";
  if (label === href) return href;
  return `[${label}](${href})`;
}

function serializeChildren(node: Node): string {
  let out = "";
  for (const child of node.childNodes) {
    out += serializeNode(child);
  }
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    // Inter-block formatting whitespace from the renderer collapses to a
    // newline; real inline whitespace passes through untouched.
    if (text.includes("\n") && text.trim().length === 0) return "\n";
    return text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.hasAttribute("data-markdown-details")) {
    return serializeDetails(element);
  }
  const markdownCopy = element.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return markdownCopy;
  if (isSkippedElement(element)) return "";

  const headingLevel = /^H([1-6])$/.exec(element.tagName)?.[1];
  if (headingLevel) {
    return `${"#".repeat(Number(headingLevel))} ${serializeChildren(element).trim()}\n\n`;
  }

  switch (element.tagName) {
    case "BR":
      return "\n";
    case "HR":
      return "---\n\n";
    case "P":
      return `${serializeChildren(element).trim()}\n\n`;
    case "PRE":
      return serializeCodeBlock(element);
    case "CODE": {
      const content = element.textContent ?? "";
      return isBlockCodeElement(element, content) ? content : wrapInlineCode(content);
    }
    case "STRONG":
    case "B":
      return wrapInlineMarker(serializeChildren(element), "**");
    case "EM":
    case "I":
      return wrapInlineMarker(serializeChildren(element), "*");
    case "DEL":
    case "S":
      return wrapInlineMarker(serializeChildren(element), "~~");
    case "A":
      return serializeAnchor(element);
    case "IMG": {
      const alt = element.getAttribute("alt") ?? "";
      const src = element.getAttribute("src") ?? "";
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "UL":
      return serializeList(element, false);
    case "OL":
      return serializeList(element, true);
    case "BLOCKQUOTE":
      return serializeBlockquote(element);
    case "TABLE":
      return serializeTable(element);
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const content = serializeChildren(element);
      return content && !content.endsWith("\n") ? `${content}\n` : content;
    }
    default:
      return serializeChildren(element);
  }
}

/**
 * Tracks whether a fragment carries exactly one code block and nothing else a
 * reader would see.
 */
interface SoleCodeBlockScan {
  pre: Element | null;
  other: boolean;
}

function scanForSoleCodeBlock(node: Node, scan: SoleCodeBlockScan): void {
  for (const child of node.childNodes) {
    if (scan.other) return;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim().length > 0) scan.other = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    // Mirrors serializeNode's order: an element carrying markdown of its own
    // still contributes it even when its tag is otherwise skipped, as a file
    // chip rendered as a button does.
    if (element.hasAttribute("data-markdown-details")) {
      scan.other = true;
      continue;
    }
    const markdownCopy = element.getAttribute("data-markdown-copy");
    if (markdownCopy !== null) {
      if (markdownCopy.trim().length > 0) scan.other = true;
      continue;
    }
    if (isSkippedElement(element)) continue;
    if (element.tagName === "PRE") {
      if (scan.pre) scan.other = true;
      else scan.pre = element;
      continue;
    }
    if (element.tagName === "IMG" || element.tagName === "HR") {
      scan.other = true;
      continue;
    }
    if (element.tagName === "LI") {
      // serializeListItem emits a marker ("- ", "1. ", "[x] ") for every item,
      // so an item that does not hold the block carries content of its own even
      // when it renders no text. An item that wraps the block is just the
      // structure around it, and a pre-only selection would drop the marker too.
      const preBeforeItem = scan.pre;
      scanForSoleCodeBlock(element, scan);
      if (!scan.other && scan.pre === preBeforeItem) scan.other = true;
      continue;
    }
    scanForSoleCodeBlock(element, scan);
  }
}

/**
 * A drag that ends on a block's final newline pulls the closing `pre` into the
 * range, so the fragment holds the whole block even though the user only
 * highlighted code. Re-fencing that pastes stray backticks, so a fragment whose
 * only visible content is one code block copies as plain code, matching a
 * selection that never left the `pre`.
 */
function soleCodeBlock(container: Node): Element | null {
  const scan: SoleCodeBlockScan = { pre: null, other: false };
  scanForSoleCodeBlock(container, scan);
  return scan.other ? null : scan.pre;
}

/** Collapses serializer spacing artifacts without touching fenced code content. */
function tidyMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/[ \t]+(?=\n)/g, "").replace(/\n{3,}/g, "\n\n"),
    )
    .join("")
    .trim();
}

/**
 * Serializes a rendered fragment back to markdown. Tables follow `tableFormat`;
 * delimited formats replace each table with its TSV or CSV rows.
 */
export function serializeRenderedMarkdownFragment(
  container: Node,
  tableFormat: TableCopyFormat = "markdown",
): string {
  const codeBlock = soleCodeBlock(container);
  if (codeBlock) return (codeBlock.textContent ?? "").replace(/\n$/, "");
  if (tableFormat === "markdown" || container.nodeType !== Node.ELEMENT_NODE) {
    return tidyMarkdown(serializeChildren(container));
  }
  // Tag a copy so the caller's fragment still produces untouched HTML. Tables
  // stay placeholders through tidyMarkdown, which would strip the tabs of empty
  // edge cells and shift the columns after them. The per-copy marker cannot
  // collide with copied text.
  const tagged = container.cloneNode(true) as Element;
  const marker = `\uE000${Math.random().toString(36).slice(2)}\uE000`;
  const delimitedTables: string[] = [];
  for (const table of tagged.querySelectorAll("table")) {
    table.setAttribute("data-markdown-copy", `${marker}${delimitedTables.length}${marker}\n\n`);
    delimitedTables.push(serializeTableElementToDelimited(table, tableFormat));
  }
  return tidyMarkdown(serializeChildren(tagged)).replace(
    new RegExp(`${marker}(\\d+)${marker}`, "g"),
    (match, index: string) => delimitedTables[Number(index)] ?? match,
  );
}

export function serializeTableElementToMarkdown(table: Element): string {
  return serializeTable(table).trim();
}

/** Collapses a cell to one line so it cannot break the row or column grid. */
function delimitedCell(value: string, format: "tsv" | "csv"): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (format === "tsv") return normalized;
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

function delimitedRows(rows: ReadonlyArray<ReadonlyArray<string>>, format: "tsv" | "csv"): string {
  const separator = format === "tsv" ? "\t" : ",";
  return rows
    .map((cells) => cells.map((cell) => delimitedCell(cell, format)).join(separator))
    .join("\n");
}

/**
 * Cell text with `<br>` kept as a word boundary and images as their alt text,
 * both of which `textContent` drops.
 */
function tableCellText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.tagName === "BR") return " ";
  if (element.tagName === "IMG") return element.getAttribute("alt") ?? "";
  return [...node.childNodes].map(tableCellText).join("");
}

/**
 * Tab-separated rows are what spreadsheets put on the clipboard, and what Slack
 * and spreadsheet apps turn back into a real table on paste.
 */
export function serializeTableElementToDelimited(table: Element, format: "tsv" | "csv"): string {
  const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")]
    .map((row) =>
      [...row.children]
        .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
        .map(tableCellText),
    )
    .filter((cells) => cells.length > 0);
  return delimitedRows(rows, format);
}

const markdownTableParser = unified().use(remarkParse).use(remarkGfm);

function markdownPlainText(node: Nodes): string {
  if (node.type === "html" || node.type === "break") return " ";
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(markdownPlainText).join("");
  return "";
}

function collectMarkdownTables(node: Nodes, tables: Table[]): void {
  if (node.type === "table") {
    tables.push(node);
    return;
  }
  if ("children" in node) {
    for (const child of node.children) collectMarkdownTables(child, tables);
  }
}

/**
 * Rewrites GFM tables in markdown source as TSV or CSV, leaving the rest of the
 * message untouched. Used when copying a whole message; cells become plain text.
 */
export function markdownWithTableCopyFormat(markdown: string, format: TableCopyFormat): string {
  if (format === "markdown" || !markdown.includes("|")) return markdown;
  const tables: Table[] = [];
  collectMarkdownTables(markdownTableParser.parse(markdown), tables);
  let result = markdown;
  for (const table of tables.toReversed()) {
    const start = table.position?.start.offset;
    const end = table.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    // GFM pads short rows and drops surplus cells to the header's width when
    // rendering; the syntax tree keeps them as written.
    const width = table.align?.length ?? table.children[0]?.children.length ?? 0;
    const rows = table.children.map((row) =>
      Array.from({ length: width }, (_, index) => {
        const cell = row.children[index];
        return cell ? markdownPlainText(cell) : "";
      }),
    );
    // A table in a blockquote or list starts after its line's container prefix
    // ("> ", indentation) and swallows that prefix on later lines. Replace from
    // the line start so no row keeps a stray marker.
    const lineStart = result.lastIndexOf("\n", start - 1) + 1;
    const replaceFrom = /^[\s>]*$/.test(result.slice(lineStart, start)) ? lineStart : start;
    result = `${result.slice(0, replaceFrom)}${delimitedRows(rows, format)}${result.slice(end)}`;
  }
  return result;
}

function sanitizedHtmlFrom(container: Element): string {
  for (const node of container.querySelectorAll(SANITIZED_HTML_SELECTOR)) {
    if (
      node.classList.contains("chat-markdown-file-link") ||
      node.closest(".chat-markdown-file-link")
    ) {
      if (node.getAttribute("aria-hidden") === "true" || node.localName === "svg") {
        node.remove();
      }
      continue;
    }
    node.remove();
  }
  return `<meta charset="utf-8">${container.innerHTML}`;
}

const TABLE_INTERIOR_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR"]);

/**
 * A range spanning several cells or rows clones without its `table`, leaving
 * nothing to serialize as a table. Rebuilds the shell from the table down to
 * the range's common ancestor around the cloned fragment.
 */
function withTableShell(ancestor: Element | null, fragment: DocumentFragment): Node {
  if (!ancestor || !TABLE_INTERIOR_TAGS.has(ancestor.tagName)) return fragment;
  const table = ancestor.closest("table");
  let shell: Node = fragment;
  for (let element: Element | null = ancestor; element; element = element.parentElement) {
    const clone = element.cloneNode(false);
    clone.appendChild(shell);
    shell = clone;
    if (element === table) break;
  }
  return shell;
}

export function chatMarkdownClipboardPayload(
  selection: Selection,
  tableFormat: TableCopyFormat = "markdown",
): MarkdownClipboardPayload | null {
  const texts: string[] = [];
  const htmls: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    const ancestor = range.commonAncestorContainer;
    const ancestorElement =
      ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
    const container = document.createElement("div");
    container.appendChild(withTableShell(ancestorElement, range.cloneContents()));
    if (ancestorElement?.closest("pre")) {
      const text = range.toString();
      if (text) {
        texts.push(text);
        htmls.push(sanitizedHtmlFrom(container));
      }
      continue;
    }
    const text = serializeRenderedMarkdownFragment(container, tableFormat);
    if (!text) continue;
    texts.push(text);
    htmls.push(sanitizedHtmlFrom(container));
  }
  if (texts.length === 0) return null;
  return { text: texts.join("\n\n"), html: htmls.join("") };
}

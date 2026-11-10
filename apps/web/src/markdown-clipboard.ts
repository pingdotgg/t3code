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

function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? "";
  if (!core) return content;
  return `${match?.[1] ?? ""}${marker}${core}${marker}${match?.[3] ?? ""}`;
}

// Highlighter spans or newlines identify block code even when its pre wrapper was not copied.
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

function outsideCodeFences(markdown: string, tidy: (prose: string) => string): string {
  // A fence closes only at its own opening run, so split yields [prose, fence, run] triples.
  return markdown
    .split(/((`{3,})[\s\S]*?(?:\2|$))/)
    .map((part, index) => (index % 3 === 0 ? tidy(part) : index % 3 === 1 ? part : ""))
    .join("");
}

function resolveCodeBlockLanguage(pre: Element): string | null {
  const declared =
    pre.closest("[data-language]")?.getAttribute("data-language") ??
    /(?:^|\s)language-(\S+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ??
    null;
  return declared && declared !== "text" ? declared : null;
}

export function serializeCodeBlockToMarkdown(source: string, language: string | null): string {
  const code = source.replace(/\n$/, "");
  const fence = codeFenceFor(code);
  return `${fence}${language ?? ""}\n${code}\n${fence}\n\n`;
}

function serializeCodeBlock(pre: Element): string {
  return serializeCodeBlockToMarkdown(pre.textContent ?? "", resolveCodeBlockLanguage(pre));
}

function serializeTableCell(cell: Element): string {
  return serializeChildren(cell, true).replace(/\n+/g, " ").trim();
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

function serializeListItem(
  item: Element,
  ordered: boolean,
  index: number,
  inTableCell: boolean,
): string {
  const checkbox = item.querySelector(
    ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
  );
  const task = checkbox ? `[${(checkbox as HTMLInputElement).checked ? "x" : " "}] ` : "";
  const bullet = ordered ? `${index}. ` : "- ";
  const marker = `${bullet}${task}`;
  let content = outsideCodeFences(serializeChildren(item, inTableCell), (prose) =>
    prose.replace(/\n{3,}/g, "\n\n"),
  ).trim();
  if (!item.querySelector(":scope > p")) {
    content = outsideCodeFences(content, (prose) => prose.replace(/\n{2,}/g, "\n"));
  }
  // Continuations align after the bullet; task boxes belong to the item text.
  const continuationIndent = " ".repeat(bullet.length);
  const [first = "", ...rest] = content.split("\n");
  return [
    `${marker}${first}`,
    ...rest.map((line) => (line.length > 0 ? `${continuationIndent}${line}` : line)),
  ].join("\n");
}

function serializeList(list: Element, ordered: boolean, inTableCell: boolean): string {
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const items = [...list.children].filter((child) => child.tagName === "LI");
  if (items.length === 0) return "";
  return `${items.map((item, index) => serializeListItem(item, ordered, start + index, inTableCell)).join("\n")}\n\n`;
}

function serializeBlockquote(quote: Element, inTableCell: boolean): string {
  const content = outsideCodeFences(serializeChildren(quote, inTableCell), (prose) =>
    prose.replace(/\n{3,}/g, "\n\n"),
  ).trim();
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

function serializeAnchor(anchor: Element, inTableCell: boolean): string {
  const markdownCopy = anchor.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return escapeTablePipes(markdownCopy, inTableCell);
  const content = serializeChildren(anchor, inTableCell);
  const href = escapeTablePipes(anchor.getAttribute("href") ?? "", inTableCell);
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return "";
  if (label === href) return href;
  return `[${label}](${href})`;
}

/**
 * GFM splits a table row at every unescaped pipe, but its math-aware parsing
 * keeps a formula's pipes in the cell, so formula source is copied unescaped.
 */
function escapeTablePipes(text: string, inTableCell: boolean): string {
  return inTableCell ? text.replaceAll("|", "\\|") : text;
}

function serializeChildren(node: Node, inTableCell = false): string {
  let out = "";
  for (const child of node.childNodes) {
    out += serializeNode(child, inTableCell);
  }
  return out;
}

function serializeNode(node: Node, inTableCell = false): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text.includes("\n") && text.trim().length === 0) return "\n";
    return escapeTablePipes(text, inTableCell);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.hasAttribute("data-markdown-details")) {
    return escapeTablePipes(serializeDetails(element), inTableCell);
  }
  const markdownCopy = element.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) {
    return element.hasAttribute("data-markdown-math")
      ? markdownCopy
      : escapeTablePipes(markdownCopy, inTableCell);
  }
  if (isSkippedElement(element)) return "";

  const headingLevel = /^H([1-6])$/.exec(element.tagName)?.[1];
  if (headingLevel) {
    return `${"#".repeat(Number(headingLevel))} ${serializeChildren(element, inTableCell).trim()}\n\n`;
  }

  switch (element.tagName) {
    case "BR":
      return "\n";
    case "HR":
      return "---\n\n";
    case "P":
      return `${serializeChildren(element, inTableCell).trim()}\n\n`;
    case "PRE":
      return escapeTablePipes(serializeCodeBlock(element), inTableCell);
    case "CODE": {
      const content = escapeTablePipes(element.textContent ?? "", inTableCell);
      return isBlockCodeElement(element, content) ? content : wrapInlineCode(content);
    }
    case "STRONG":
    case "B":
      return wrapInlineMarker(serializeChildren(element, inTableCell), "**");
    case "EM":
    case "I":
      return wrapInlineMarker(serializeChildren(element, inTableCell), "*");
    case "DEL":
    case "S":
      return wrapInlineMarker(serializeChildren(element, inTableCell), "~~");
    case "A":
      return serializeAnchor(element, inTableCell);
    case "IMG": {
      const alt = escapeTablePipes(element.getAttribute("alt") ?? "", inTableCell);
      const src = escapeTablePipes(element.getAttribute("src") ?? "", inTableCell);
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "UL":
      return serializeList(element, false, inTableCell);
    case "OL":
      return serializeList(element, true, inTableCell);
    case "BLOCKQUOTE":
      return serializeBlockquote(element, inTableCell);
    case "TABLE":
      return escapeTablePipes(serializeTable(element), inTableCell);
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const content = serializeChildren(element, inTableCell);
      return content && !content.endsWith("\n") ? `${content}\n` : content;
    }
    default:
      return serializeChildren(element, inTableCell);
  }
}

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
    // Explicit markdown still counts on skipped tags such as file-chip buttons.
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
      const preBeforeItem = scan.pre;
      scanForSoleCodeBlock(element, scan);
      if (!scan.other && scan.pre === preBeforeItem) scan.other = true;
      continue;
    }
    scanForSoleCodeBlock(element, scan);
  }
}

// Selecting a block's final newline pulls in its closing pre even when only code was highlighted.
function soleCodeBlock(container: Node): Element | null {
  const scan: SoleCodeBlockScan = { pre: null, other: false };
  scanForSoleCodeBlock(container, scan);
  return scan.other ? null : scan.pre;
}

function tidyMarkdown(markdown: string): string {
  return outsideCodeFences(markdown, (prose) =>
    prose.replace(/[ \t]+(?=\n)/g, "").replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

export function serializeRenderedMarkdownFragment(container: Node): string {
  const codeBlock = soleCodeBlock(container);
  if (codeBlock) return (codeBlock.textContent ?? "").replace(/\n$/, "");
  return tidyMarkdown(serializeChildren(container));
}

export function serializeTableElementToMarkdown(table: Element): string {
  return serializeTable(table).trim();
}

// The wrapper MarkdownMath puts on every formula it renders. The sanitizer drops
// the attribute from authored HTML.
const MATH_SELECTOR = "[data-markdown-math]";

export function mathWrapperOf(element: Element | null): Element | null {
  return element?.closest(MATH_SELECTOR) ?? null;
}

/** A cell's text, with each formula as its TeX. */
function csvCellText(cell: Element): string {
  if (!cell.querySelector(MATH_SELECTOR)) return cell.textContent ?? "";
  const copy = cell.cloneNode(true) as Element;
  for (const wrapper of copy.querySelectorAll(MATH_SELECTOR)) {
    wrapper.replaceWith(wrapper.getAttribute("data-markdown-copy")?.trim() ?? "");
  }
  return copy.textContent ?? "";
}

function csvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

export function serializeTableElementToCsv(table: Element): string {
  const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];
  const lines: string[] = [];
  for (const row of rows) {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    if (cells.length === 0) continue;
    lines.push(cells.map((cell) => csvCell(csvCellText(cell))).join(","));
  }
  return lines.join("\n");
}

const TABLE_SECTION_TAGS = new Set(["THEAD", "TBODY", "TFOOT"]);
// Elements that start a new line inside a copied cell.
const HTML_CELL_BLOCK_TAGS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DETAILS",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TR",
  "UL",
]);

// Inline and theme-independent: mail clients and editors drop stylesheets, and a
// copy from the dark theme must still read on a white page. Header cells set their
// own text color so the light band stays readable in a dark paste target.
const HTML_TABLE_STYLE = "border-collapse:collapse";
const HTML_CELL_STYLE = "border:1px solid #d0d7de;padding:6px 12px;vertical-align:top";
const HTML_HEADER_CELL_STYLE = `${HTML_CELL_STYLE};background-color:#f6f8fa;color:#1f2328;font-weight:600`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Markers in collected cell text: a block edge is a soft line boundary, a break is a <br>.
const CELL_BLOCK_EDGE = "\u0001";
const CELL_LINE_BREAK = "\u0002";
// HTML's collapsible whitespace; a nonbreaking space is content.
const COLLAPSIBLE_WHITESPACE = /[ \t\n\r\f]+/g;

/** Preformatted text keeps its lines and spacing as breaks and nonbreaking spaces. */
function preformattedCellText(text: string): string {
  return text
    .replace(/\r\n?|\n/g, CELL_LINE_BREAK)
    .replaceAll("\t", " ".repeat(4))
    .replaceAll(" ", " ");
}

/** Collects a cell's text with block edges and breaks marked, and each formula as its TeX. */
function collectHtmlCellText(node: Node, parts: string[], preformatted: boolean): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      parts.push(preformatted ? preformattedCellText(text) : text);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    if (element.hasAttribute("data-markdown-math")) {
      parts.push(element.getAttribute("data-markdown-copy")?.trim() ?? "");
      continue;
    }
    if (element.tagName === "BR") {
      parts.push(CELL_LINE_BREAK);
      continue;
    }
    if (element.tagName === "PRE") {
      const code: string[] = [];
      collectHtmlCellText(element, code, true);
      // A code block's closing newline ends the block, not a blank line.
      parts.push(CELL_BLOCK_EDGE, code.join("").replace(/\u0002$/, ""), CELL_BLOCK_EDGE);
      continue;
    }
    // Cells of a nested table stay apart on their row's line.
    const separator = element.tagName === "TD" || element.tagName === "TH" ? " " : "";
    const boundary = HTML_CELL_BLOCK_TAGS.has(element.tagName) ? CELL_BLOCK_EDGE : separator;
    parts.push(boundary);
    collectHtmlCellText(element, parts, preformatted);
    parts.push(boundary);
  }
}

/**
 * Every explicit break stays a <br>, including repeated and edge ones. Block edges
 * become one break between content, and none where a break already ends the line.
 */
function htmlCellContent(cell: Element): string {
  const parts: string[] = [];
  collectHtmlCellText(cell, parts, false);
  const tokens = parts
    .join("")
    .replace(COLLAPSIBLE_WHITESPACE, " ")
    .split(/([\u0001\u0002])/);
  let html = "";
  let atLineStart = true;
  let pendingBlockEdge = false;
  for (const token of tokens) {
    if (token === CELL_LINE_BREAK) {
      html = `${html.replace(/ +$/, "")}<br>`;
      atLineStart = true;
      pendingBlockEdge = false;
    } else if (token === CELL_BLOCK_EDGE) {
      pendingBlockEdge = true;
    } else {
      const text = atLineStart || pendingBlockEdge ? token.replace(/^ +/, "") : token;
      if (!text) continue;
      if (pendingBlockEdge && !atLineStart) html = `${html.replace(/ +$/, "")}<br>`;
      html += escapeHtml(text).replaceAll(" ", "&nbsp;");
      atLineStart = false;
      pendingBlockEdge = false;
    }
  }
  return html.replace(/ +$/, "");
}

/** Physical alignment for a paste target; logical values follow the table direction. */
function htmlCellAlignment(align: string, rtl: boolean): string {
  switch (align) {
    case "left":
    case "center":
    case "right":
    case "justify":
      return align;
    case "start":
      return rtl ? "right" : "left";
    case "end":
      return rtl ? "left" : "right";
    default:
      return "";
  }
}

/** HTML's non-negative integer parsing: leading digits count, anything invalid is 1. */
function parseTableSpan(value: string | null): number {
  const span = Number.parseInt(value ?? "", 10);
  return Number.isNaN(span) || span < 0 ? 1 : span;
}

function htmlSpanAttributes(cell: Element): string {
  // The DOM normalizes spans; the attribute fallback covers non-DOM callers.
  const { colSpan, rowSpan } = cell as Partial<HTMLTableCellElement>;
  const columns =
    typeof colSpan === "number" ? colSpan : parseTableSpan(cell.getAttribute("colspan"));
  const rows = typeof rowSpan === "number" ? rowSpan : parseTableSpan(cell.getAttribute("rowspan"));
  let attributes = columns > 1 ? ` colspan="${columns}"` : "";
  // rowspan="0" runs to the end of its section.
  if (rows !== 1) attributes += ` rowspan="${rows}"`;
  return attributes;
}

function htmlTableCell(cell: Element, rtl: boolean): string {
  const tag = cell.tagName === "TH" ? "th" : "td";
  // An absent inline style reads as "", so fall back to the align attribute on any falsy value.
  const align = (cell as HTMLElement).style?.textAlign || cell.getAttribute("align") || "";
  // Header cells default to the start side like the chat; paste targets would center them.
  const textAlign = htmlCellAlignment(align || (tag === "th" ? "start" : ""), rtl);
  const style = `${tag === "th" ? HTML_HEADER_CELL_STYLE : HTML_CELL_STYLE}${textAlign ? `;text-align:${textAlign}` : ""}`;
  // Bare text, no <p>: Word would drop its 8pt gap but switch to its web font.
  return `<${tag} style="${style}"${htmlSpanAttributes(cell)}>${htmlCellContent(cell)}</${tag}>`;
}

function htmlTableSection(tag: string, rows: ReadonlyArray<Element>, rtl: boolean): string[] {
  let hasCells = false;
  const lines = rows.map((row) => {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    const html = cells.map((cell) => htmlTableCell(cell, rtl)).join("");
    hasCells ||= cells.length > 0;
    return `    <tr>${html}</tr>`;
  });
  return hasCells ? [`  <${tag}>`, ...lines, `  </${tag}>`] : [];
}

/**
 * Inline-styled `<table>` markup without app chrome, so rich paste targets get a table.
 * Sections, header cells, spans, line breaks, direction, and alignment follow the source.
 * Cell content is text: inline formatting and link targets are not copied.
 */
export function serializeTableElementToHtml(table: Element): string {
  const rtl = table.getAttribute("dir") === "rtl";
  const lines: string[] = [];
  let looseRows: Element[] = [];
  const flushLooseRows = () => {
    lines.push(...htmlTableSection("tbody", looseRows, rtl));
    looseRows = [];
  };
  for (const child of table.children) {
    if (child.tagName === "TR") {
      looseRows.push(child);
      continue;
    }
    if (!TABLE_SECTION_TAGS.has(child.tagName)) continue;
    flushLooseRows();
    const rows = [...child.children].filter((row) => row.tagName === "TR");
    lines.push(...htmlTableSection(child.tagName.toLowerCase(), rows, rtl));
  }
  flushLooseRows();
  const open = `<table${rtl ? ' dir="rtl"' : ""} style="${HTML_TABLE_STYLE}">`;
  return lines.length > 0 ? [open, ...lines, "</table>"].join("\n") : "";
}

function mermaidSourceHtml(source: string) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source.trim();
  pre.appendChild(code);
  return pre;
}

function mathSourceElement(wrapper: Element): Element {
  const code = document.createElement("code");
  code.textContent = wrapper.getAttribute("data-markdown-copy")?.trim() ?? "";
  if (wrapper.getAttribute("data-markdown-math") !== "display") return code;
  const pre = document.createElement("pre");
  pre.append(code);
  return pre;
}

function sanitizedHtmlFrom(container: Element): string {
  for (const diagram of container.querySelectorAll("[data-markdown-mermaid]")) {
    const source = diagram.getAttribute("data-markdown-copy");
    if (source !== null) diagram.replaceChildren(mermaidSourceHtml(source));
  }
  for (const wrapper of container.querySelectorAll(MATH_SELECTOR)) {
    wrapper.replaceWith(mathSourceElement(wrapper));
  }
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

export function chatMarkdownClipboardPayload(
  selection: Selection,
): MarkdownClipboardPayload | null {
  const texts: string[] = [];
  const htmls: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    const ancestor = range.commonAncestorContainer;
    const ancestorElement =
      ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
    const diagramSource = ancestorElement
      ?.closest("[data-markdown-mermaid]")
      ?.getAttribute("data-markdown-copy");
    if (diagramSource != null) {
      const text = diagramSource.trim();
      if (!text) continue;
      texts.push(text);
      container.replaceChildren(mermaidSourceHtml(diagramSource));
      htmls.push(sanitizedHtmlFrom(container));
      continue;
    }
    // A range inside a formula would clone only KaTeX's glyphs, not the wrapper holding the TeX.
    const math = mathWrapperOf(ancestorElement);
    if (math) {
      texts.push(math.getAttribute("data-markdown-copy")?.trim() ?? "");
      htmls.push(`<meta charset="utf-8">${mathSourceElement(math).outerHTML}`);
      continue;
    }
    if (ancestorElement?.closest("pre")) {
      const text = range.toString();
      if (text) {
        texts.push(text);
        htmls.push(sanitizedHtmlFrom(container));
      }
      continue;
    }
    const text = serializeRenderedMarkdownFragment(container);
    if (!text) continue;
    texts.push(text);
    htmls.push(sanitizedHtmlFrom(container));
  }
  if (texts.length === 0) return null;
  return { text: texts.join("\n\n"), html: htmls.join("") };
}

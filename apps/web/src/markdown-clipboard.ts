/**
 * Converts a DOM selection inside rendered chat markdown back into markdown
 * source so highlight-and-copy keeps formatting (links, emphasis, lists,
 * fences, tables) instead of flattening to plain text. The `text/plain`
 * clipboard flavor carries the markdown; `text/html` carries a sanitized
 * copy of the rendered fragment for rich-paste targets.
 */

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
  const checkbox = item.querySelector('input[type="checkbox"]');
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
    case "CODE":
      return wrapInlineCode(element.textContent ?? "");
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

export function serializeRenderedMarkdownFragment(container: Node): string {
  return tidyMarkdown(serializeChildren(container));
}

export function serializeTableElementToMarkdown(table: Element): string {
  return serializeTable(table).trim();
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
    lines.push(cells.map((cell) => csvCell(cell.textContent ?? "")).join(","));
  }
  return lines.join("\n");
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
    const text = serializeRenderedMarkdownFragment(container);
    if (!text) continue;
    texts.push(text);
    htmls.push(sanitizedHtmlFrom(container));
  }
  if (texts.length === 0) return null;
  return { text: texts.join("\n\n"), html: htmls.join("") };
}

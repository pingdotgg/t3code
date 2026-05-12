import { type AssistantResponseCopyFormat } from "@t3tools/contracts/settings";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { LRUCache } from "./lruCache";

type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string;
  url?: string;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  children?: MarkdownNode[];
};

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);
const MAX_PLAIN_TEXT_CACHE_ENTRIES = 500;
const MAX_PLAIN_TEXT_CACHE_MEMORY_BYTES = 5 * 1024 * 1024;
const plainTextCache = new LRUCache<string>(
  MAX_PLAIN_TEXT_CACHE_ENTRIES,
  MAX_PLAIN_TEXT_CACHE_MEMORY_BYTES,
);

export function resolveAssistantMessageCopyText(
  messageText: string,
  format: AssistantResponseCopyFormat,
): string {
  if (format === "markdown") {
    return messageText;
  }

  return getCachedPlainText(messageText);
}

export function hasAssistantResponseCopyText(
  messageText: string,
  format: AssistantResponseCopyFormat,
): boolean {
  if (messageText.trim().length === 0) {
    return false;
  }

  return resolveAssistantMessageCopyText(messageText, format).trim().length > 0;
}

export function markdownToPlainText(markdown: string): string {
  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  if (normalizedMarkdown.trim().length === 0) {
    return "";
  }

  const tree = markdownProcessor.parse(normalizedMarkdown) as MarkdownNode;
  return normalizePlainText(renderBlockChildren(tree.children ?? []));
}

function renderBlockChildren(nodes: readonly MarkdownNode[]): string {
  return nodes
    .map((node) => renderBlock(node))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function renderBlock(node: MarkdownNode): string {
  switch (node.type) {
    case "root":
    case "blockquote":
      return renderBlockChildren(node.children ?? []);
    case "paragraph":
    case "heading":
      return normalizeInlineText(renderInlineChildren(node.children ?? []));
    case "code":
      return normalizeCodeBlock(node.value ?? "");
    case "list":
      return renderList(node);
    case "table":
      return renderTable(node);
    case "html":
      return normalizeCodeBlock(node.value ?? "");
    case "thematicBreak":
      return "";
    default:
      return normalizeInlineText(renderInline(node));
  }
}

function renderList(node: MarkdownNode): string {
  const items = node.children ?? [];
  const ordered = Boolean(node.ordered);
  const start = typeof node.start === "number" ? node.start : 1;

  return items
    .map((item, index) => renderListItem(item, ordered ? `${start + index}. ` : "- "))
    .filter((item) => item.length > 0)
    .join("\n");
}

function renderListItem(node: MarkdownNode, marker: string): string {
  const blocks = (node.children ?? [])
    .map((child) => renderBlock(child))
    .filter((block) => block.length > 0);
  const taskPrefix = node.checked === true ? "[x] " : node.checked === false ? "[ ] " : "";
  const contentPrefix = `${marker}${taskPrefix}`;

  if (blocks.length === 0) {
    return contentPrefix.trimEnd();
  }

  const continuationPrefix = " ".repeat(contentPrefix.length);
  const firstBlock = blocks[0]!;
  const remainingBlocks = blocks.slice(1);
  const firstBlockLines = splitLines(firstBlock);
  const lines = firstBlockLines.map((line, index) =>
    index === 0 ? `${contentPrefix}${line}` : `${continuationPrefix}${line}`,
  );

  for (const block of remainingBlocks) {
    for (const line of splitLines(block)) {
      lines.push(`${continuationPrefix}${line}`);
    }
  }

  return lines.join("\n");
}

function renderTable(node: MarkdownNode): string {
  return (node.children ?? [])
    .map((row) =>
      (row.children ?? [])
        .map((cell) => normalizeInlineText(renderInlineChildren(cell.children ?? [])))
        .join(" | "),
    )
    .filter((row) => row.length > 0)
    .join("\n");
}

function renderInlineChildren(nodes: readonly MarkdownNode[]): string {
  return nodes.map((node) => renderInline(node)).join("");
}

function renderInline(node: MarkdownNode): string {
  switch (node.type) {
    case "text":
      return (node.value ?? "").replace(/\r?\n+/g, " ");
    case "inlineCode":
    case "html":
      return node.value ?? "";
    case "break":
      return "\n";
    case "link": {
      const label = normalizeInlineText(renderInlineChildren(node.children ?? []));
      if (label.length > 0) {
        return label;
      }
      return typeof node.url === "string" ? node.url : "";
    }
    case "image":
      return node.alt?.trim() || node.url || "";
    case "delete":
    case "emphasis":
    case "strong":
    case "paragraph":
    case "heading":
      return renderInlineChildren(node.children ?? []);
    default:
      return renderInlineChildren(node.children ?? []);
  }
}

function normalizeCodeBlock(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
}

function normalizeInlineText(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizePlainText(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/g, "");
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

function getCachedPlainText(markdown: string): string {
  const cached = plainTextCache.get(markdown);
  if (cached !== null) {
    return cached;
  }

  const plainText = markdownToPlainText(markdown);
  plainTextCache.set(markdown, plainText, plainText.length * 2);
  return plainText;
}

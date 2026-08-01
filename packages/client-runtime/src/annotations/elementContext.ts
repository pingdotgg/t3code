import type { PickedElementPayload, PickedElementStackFrame } from "@t3tools/contracts";

const ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;
const ELEMENT_CONTEXT_LABEL_TAG_MAX = 24;
const ELEMENT_CONTEXT_BLOCK_MAX_CHARS = 48_000;

interface ElementContextSelection {
  pageUrl: string;
  pageTitle: string | null;
  tagName: string;
  selector: string | null;
  htmlPreview: string;
  componentName: string | null;
  source: PickedElementStackFrame | null;
  styles: string;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function normalizeElementContextSelection(
  raw: PickedElementPayload,
): ElementContextSelection | null {
  const pageUrl = raw.pageUrl.trim();
  const tagName = raw.tagName.trim().toLowerCase();
  if (pageUrl.length === 0 || tagName.length === 0) {
    return null;
  }
  const stackFrame = raw.source ?? raw.stack[0] ?? null;
  return {
    pageUrl,
    pageTitle: raw.pageTitle?.trim() ?? null,
    tagName,
    selector: raw.selector?.trim() || null,
    htmlPreview: truncateString(normalizeText(raw.htmlPreview), ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT),
    componentName: raw.componentName?.trim() || null,
    source: stackFrame
      ? {
          functionName: stackFrame.functionName?.trim() || null,
          fileName: stackFrame.fileName?.trim() || null,
          lineNumber: stackFrame.lineNumber ?? null,
          columnNumber: stackFrame.columnNumber ?? null,
        }
      : null,
    styles: truncateString(normalizeText(raw.styles), ELEMENT_CONTEXT_STYLES_LIMIT),
  };
}

function shortenTagLabel(tagName: string): string {
  if (tagName.length <= ELEMENT_CONTEXT_LABEL_TAG_MAX) return tagName;
  return `${tagName.slice(0, ELEMENT_CONTEXT_LABEL_TAG_MAX - 1)}…`;
}

function formatElementContextLabel(context: ElementContextSelection): string {
  if (context.componentName) return `<${context.componentName}>`;
  return `<${shortenTagLabel(context.tagName)}>`;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

function formatElementContextSourceLabel(context: ElementContextSelection): string | null {
  const source = context.source;
  if (!source?.fileName) return null;
  const base = basenameFromPath(source.fileName);
  if (source.lineNumber == null) return base;
  return `${base}:${source.lineNumber}`;
}

function buildContextHeader(context: ElementContextSelection): string {
  const label = formatElementContextLabel(context);
  const source = formatElementContextSourceLabel(context);
  return source ? `${label} (${source})` : label;
}

function indentLines(value: string): string[] {
  return value.split("\n").map((line) => `  ${line}`);
}

function buildSingleContextLines(context: ElementContextSelection): string[] {
  const lines: string[] = [];
  lines.push(`- ${buildContextHeader(context)}:`);
  if (context.pageUrl.length > 0) {
    lines.push(`  url: ${context.pageUrl}`);
  }
  if (context.selector) {
    lines.push(`  selector: ${context.selector}`);
  }
  if (context.source?.fileName) {
    const { fileName, lineNumber, columnNumber } = context.source;
    const location =
      lineNumber != null
        ? `${fileName}:${lineNumber}${columnNumber != null ? `:${columnNumber}` : ""}`
        : fileName;
    lines.push(`  source: ${location}`);
  }
  const html = context.htmlPreview.trim();
  if (html.length > 0) {
    lines.push("  html:");
    lines.push(...indentLines(html));
  }
  const styles = context.styles.trim();
  if (styles.length > 0) {
    lines.push("  styles:");
    lines.push(...indentLines(styles));
  }
  return lines;
}

export function buildElementContextBlock(contexts: ReadonlyArray<ElementContextSelection>): string {
  if (contexts.length === 0) return "";
  const lines = ["<element_context>"];
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index]!;
    const contextLines = buildSingleContextLines(context);
    const separator = lines.length > 1 ? [""] : [];
    const closingLine = "</element_context>";
    const candidate = [...lines, ...separator, ...contextLines, closingLine].join("\n");
    if (candidate.length > ELEMENT_CONTEXT_BLOCK_MAX_CHARS) {
      const omitted = contexts.length - index;
      lines.push(
        "",
        `- … ${omitted} additional element context${omitted === 1 ? "" : "s"} omitted to fit the annotation context budget.`,
      );
      break;
    }
    lines.push(...separator, ...contextLines);
  }
  lines.push("</element_context>");
  return lines.join("\n");
}

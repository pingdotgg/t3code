/**
 * Element-selection context — the package port of the subset of the native
 * elementContext module that the annotation prompt builder
 * consumes (sanitize a pick payload, then serialize the `<element_context>`
 * block). The composer-side extras in the native file (prompt
 * append/extract, chip dedupe keys, draft ids) belong to the deferred
 * `t3.composer/context` consumer and are intentionally not ported yet.
 */
import type { PickedElementPayload, PickedElementStackFrame } from "@t3tools/contracts";

const ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT = 4000;
const ELEMENT_CONTEXT_STYLES_LIMIT = 4000;
const ELEMENT_CONTEXT_LABEL_TAG_MAX = 24;
// Every picker-supplied string is clamped before it can reach a prompt or
// persisted state — the picker's output is untrusted in size even though
// its shape is contracted.
const ELEMENT_CONTEXT_PAGE_URL_LIMIT = 2048;
const ELEMENT_CONTEXT_PAGE_TITLE_LIMIT = 512;
const ELEMENT_CONTEXT_TAG_NAME_LIMIT = 64;
const ELEMENT_CONTEXT_SELECTOR_LIMIT = 1024;
const ELEMENT_CONTEXT_COMPONENT_NAME_LIMIT = 128;
const ELEMENT_CONTEXT_FUNCTION_NAME_LIMIT = 256;
const ELEMENT_CONTEXT_FILE_NAME_LIMIT = 512;

/**
 * Stable, persistable element selection captured from the in-app preview
 * browser. Kept JSON-serializable so it can ride through persistence,
 * draft restoration, and transcript snapshots without bespoke marshalling.
 */
export interface ElementContextSelection {
  /** Page URL where the element was picked. */
  pageUrl: string;
  /** Best-effort `<title>`. */
  pageTitle: string | null;
  /** Lowercase tag, e.g. `"button"`. */
  tagName: string;
  /** CSS selector — may be null when react-grab can't compute one. */
  selector: string | null;
  /** Truncated outer-HTML preview. */
  htmlPreview: string;
  /** Nearest React component display name, or null. */
  componentName: string | null;
  /** Source frame (file + line) — null when unavailable. */
  source: PickedElementStackFrame | null;
  /** Author CSS (no UA defaults). May be empty. */
  styles: string;
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Sanitize a payload coming back from the picker before it lands in a
 * prompt. Trims/clamps every string field so a giant outerHTML blob never
 * reaches persisted state.
 */
export function normalizeElementContextSelection(
  raw: PickedElementPayload,
): ElementContextSelection | null {
  const pageUrl = truncateString(raw.pageUrl.trim(), ELEMENT_CONTEXT_PAGE_URL_LIMIT);
  const tagName = truncateString(raw.tagName.trim().toLowerCase(), ELEMENT_CONTEXT_TAG_NAME_LIMIT);
  if (pageUrl.length === 0 || tagName.length === 0) {
    return null;
  }
  const stackFrame = raw.source ?? raw.stack[0] ?? null;
  const trimmedTitle = raw.pageTitle?.trim();
  return {
    pageUrl,
    pageTitle:
      trimmedTitle === undefined
        ? null
        : truncateString(trimmedTitle, ELEMENT_CONTEXT_PAGE_TITLE_LIMIT),
    tagName,
    selector: raw.selector?.trim()
      ? truncateString(raw.selector.trim(), ELEMENT_CONTEXT_SELECTOR_LIMIT)
      : null,
    htmlPreview: truncateString(normalizeText(raw.htmlPreview), ELEMENT_CONTEXT_HTML_PREVIEW_LIMIT),
    componentName: raw.componentName?.trim()
      ? truncateString(raw.componentName.trim(), ELEMENT_CONTEXT_COMPONENT_NAME_LIMIT)
      : null,
    source: stackFrame
      ? {
          functionName: stackFrame.functionName?.trim()
            ? truncateString(stackFrame.functionName.trim(), ELEMENT_CONTEXT_FUNCTION_NAME_LIMIT)
            : null,
          fileName: stackFrame.fileName?.trim()
            ? truncateString(stackFrame.fileName.trim(), ELEMENT_CONTEXT_FILE_NAME_LIMIT)
            : null,
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

/**
 * Compact chip label — `<Button>` for component picks, `<button>` otherwise.
 * Component name takes priority because it's higher-signal for the agent.
 */
export function formatElementContextLabel(context: ElementContextSelection): string {
  if (context.componentName) return `<${context.componentName}>`;
  return `<${shortenTagLabel(context.tagName)}>`;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function formatElementContextSourceLabel(context: ElementContextSelection): string | null {
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

/**
 * Serialize element-context drafts into the `<element_context>` block we
 * append to the user's outgoing message text. Mirrors the
 * `<terminal_context>` block format so it composes cleanly when both are
 * present.
 */
export function buildElementContextBlock(contexts: ReadonlyArray<ElementContextSelection>): string {
  if (contexts.length === 0) return "";
  const lines: string[] = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index]!;
    lines.push(...buildSingleContextLines(context));
    if (index < contexts.length - 1) lines.push("");
  }
  return ["<element_context>", ...lines, "</element_context>"].join("\n");
}

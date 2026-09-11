import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  type ComposerContextId,
  type ComposerContextKind,
  type ComposerContextRecord,
  type ElementContextDetails,
  type KnownComposerContextRecord,
} from "@t3tools/contracts";

/**
 * Canonical inline reference: `[label](t3-context://v1/<kind>/<contextId>)`, or the image
 * form `![label](...)`. The link carries position and identity only; the payload lives in the
 * message's context records. Labels are display text and never identity.
 */

const CONTEXT_PROTOCOL = "t3-context:";
const COMPOSER_CONTEXT_HREF_PREFIX = `${CONTEXT_PROTOCOL}//v1/`;
const CONTEXT_KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const CONTEXT_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const MAX_LINK_LABEL_LENGTH = 512;
const CONTEXT_LINK = new RegExp(
  String.raw`(!?)\[([^\]\n]{0,${MAX_LINK_LABEL_LENGTH}})\]\((${COMPOSER_CONTEXT_HREF_PREFIX}[^\s)]{1,200})\)`,
  "g",
);

export function formatComposerContextHref(kind: ComposerContextKind, contextId: ComposerContextId) {
  return `${COMPOSER_CONTEXT_HREF_PREFIX}${kind}/${contextId}`;
}

export function parseComposerContextHref(
  href: string,
): { kind: ComposerContextKind; contextId: ComposerContextId } | null {
  if (!href.startsWith(COMPOSER_CONTEXT_HREF_PREFIX)) return null;
  const rest = href.slice(COMPOSER_CONTEXT_HREF_PREFIX.length);
  const parts = rest.split("/");
  if (parts.length !== 2) return null;
  const [kind, contextId] = parts as [string, string];
  if (!CONTEXT_KIND_PATTERN.test(kind) || !CONTEXT_ID_PATTERN.test(contextId)) return null;
  return { kind, contextId: contextId as ComposerContextId };
}

/** Labels must survive a Markdown link: no brackets or line breaks, bounded, never empty. */
export function sanitizeComposerContextLabel(label: string, kind: ComposerContextKind): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, COMPOSER_CONTEXT_LABEL_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : kind;
}

export function formatComposerContextReference(reference: {
  kind: ComposerContextKind;
  contextId: ComposerContextId;
  label: string;
}): string {
  const label = sanitizeComposerContextLabel(reference.label, reference.kind);
  const href = formatComposerContextHref(reference.kind, reference.contextId);
  return `${reference.kind === "image" ? "!" : ""}[${label}](${href})`;
}

export interface ComposerContextReferenceOccurrence {
  kind: ComposerContextKind;
  contextId: ComposerContextId;
  label: string;
  /** Whether the occurrence used the `![...]` image form. */
  image: boolean;
  source: string;
  start: number;
  end: number;
}

export function collectComposerContextReferences(
  text: string,
): ComposerContextReferenceOccurrence[] {
  const occurrences: ComposerContextReferenceOccurrence[] = [];
  for (const match of text.matchAll(CONTEXT_LINK)) {
    const parsed = parseComposerContextHref(match[3]!);
    if (!parsed) continue;
    occurrences.push({
      ...parsed,
      label: sanitizeComposerContextLabel(match[2]!, parsed.kind),
      image: match[1] === "!",
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return occurrences;
}

export function replaceComposerContextReferences(
  text: string,
  replace: (occurrence: ComposerContextReferenceOccurrence) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const occurrence of collectComposerContextReferences(text)) {
    result += text.slice(cursor, occurrence.start) + replace(occurrence);
    cursor = occurrence.end;
  }
  return result + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// Provider projection
// ---------------------------------------------------------------------------

const CONTEXT_ENVELOPE_TAG = "t3_context";
const CONTEXT_ENTRY_TAG = "context";

function kindDisplayName(kind: ComposerContextKind): string {
  const spaced = kind.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `[Image: shot.png; ref=ctx_1]` — readable in place, with the id the payload is keyed by. */
export function formatComposerContextProviderMarker(
  kind: ComposerContextKind,
  label: string,
  contextId: ComposerContextId,
): string {
  const cleanLabel = label
    .replace(/[\r\n;\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[${kindDisplayName(kind)}: ${escapeComposerContextPayloadText(cleanLabel)}; ref=${contextId}]`;
}

/**
 * Captured text is data. A terminal line or PR comment that contains `</t3_context>` or
 * `</context>` must not be able to close the envelope and forge a record.
 */
function escapeComposerContextPayloadText(text: string): string {
  return text.replace(
    new RegExp(String.raw`<(?=/?(?:${CONTEXT_ENVELOPE_TAG}|${CONTEXT_ENTRY_TAG})\b)`, "gi"),
    "&lt;",
  );
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function formatSourceLocation(source: {
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}): string | null {
  if (!source.fileName) return null;
  if (source.lineNumber == null) return source.fileName;
  return `${source.fileName}:${source.lineNumber}${source.columnNumber != null ? `:${source.columnNumber}` : ""}`;
}

function formatElementDetails(element: ElementContextDetails): string[] {
  const lines = [`url: ${element.pageUrl}`, `tag: ${element.tagName}`];
  if (element.pageTitle) lines.push(`title: ${element.pageTitle}`);
  if (element.selector) lines.push(`selector: ${element.selector}`);
  if (element.componentName) lines.push(`component: ${element.componentName}`);
  const location = element.source ? formatSourceLocation(element.source) : null;
  if (location) lines.push(`source: ${location}`);
  if (element.htmlPreview.trim()) lines.push("html:", indent(element.htmlPreview.trim()));
  if (element.styles.trim()) lines.push("styles:", indent(element.styles.trim()));
  return lines;
}

/** Body lines for one payload, including authoritative paths and names behind display labels. */
function formatComposerContextProviderPayload(record: KnownComposerContextRecord): string {
  switch (record.kind) {
    case "image":
    case "file":
      return [
        `name: ${record.name}`,
        `mimeType: ${record.mimeType}`,
        `sizeBytes: ${record.sizeBytes}`,
        `attachmentId: ${record.attachmentId}`,
      ].join("\n");
    case "terminal": {
      const lines = record.text
        .split("\n")
        .slice(0, record.lineEnd - record.lineStart + 1)
        .map((line, index) => `${record.lineStart + index} | ${line}`);
      return [`terminal: ${record.terminalLabel}`, ...lines].join("\n");
    }
    case "element":
      return formatElementDetails(record).join("\n");
    case "preview-annotation": {
      const lines = [
        `page: ${record.pageTitle?.trim() || record.pageUrl}`,
        `url: ${record.pageUrl}`,
      ];
      if (record.comment.trim()) lines.push(`comment: ${record.comment.trim()}`);
      if (record.targetSummary) lines.push(`targets: ${record.targetSummary}`);
      if (record.styleChanges.length > 0) {
        lines.push(
          "requested visual changes:",
          ...record.styleChanges.map((change) => `- ${change}`),
        );
      }
      if (record.screenshotContextId) lines.push(`screenshot: ref=${record.screenshotContextId}`);
      for (const [index, element] of (record.elements ?? []).entries()) {
        lines.push(`element ${index + 1}:`, indent(formatElementDetails(element).join("\n")));
      }
      return lines.join("\n");
    }
    case "review-comment": {
      const lines = [
        `file: ${record.filePath}`,
        `range: ${record.rangeLabel} (${record.startIndex}-${record.endIndex})`,
        `section: ${record.sectionTitle}`,
      ];
      if (record.text.trim()) lines.push("comment:", indent(record.text.trim()));
      if (record.diff.trim()) {
        lines.push(`${record.fenceLanguage ?? "diff"}:`, indent(record.diff.trimEnd()));
      }
      return lines.join("\n");
    }
    case "mention":
      return `path: ${record.path}`;
    case "skill":
      return `name: ${record.name}`;
  }
}

function formatEnvelopeEntry(
  kind: ComposerContextKind,
  contextId: ComposerContextId,
  record: ComposerContextRecord | undefined,
): string {
  const open = `<${CONTEXT_ENTRY_TAG} kind="${escapeAttribute(kind)}" id="${escapeAttribute(contextId)}"`;
  if (!record) return `${open} unavailable="true"/>`;
  const body =
    "payload" in record
      ? JSON.stringify(record.payload)
      : formatComposerContextProviderPayload(record);
  return `${open}>\n${escapeComposerContextPayloadText(body)}\n</${CONTEXT_ENTRY_TAG}>`;
}

/**
 * What the provider reads: every reference becomes an in-place marker, and each unique
 * referenced payload appears once in a trailing envelope, in first-reference order.
 * Unreferenced records are not emitted. Binary attachments travel on their own channel.
 */
export function projectComposerContextForProvider(input: {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
}): string {
  const occurrences = collectComposerContextReferences(input.text);
  if (occurrences.length === 0) return input.text;
  const recordsById = new Map<ComposerContextId, ComposerContextRecord | undefined>();
  for (const record of input.records) {
    // Even callers that bypass the wire schema must not silently select an ambiguous payload.
    recordsById.set(record.contextId, recordsById.has(record.contextId) ? undefined : record);
  }
  const body = replaceComposerContextReferences(input.text, (occurrence) =>
    formatComposerContextProviderMarker(
      recordsById.get(occurrence.contextId)?.kind ?? occurrence.kind,
      occurrence.label,
      occurrence.contextId,
    ),
  );
  const seen = new Set<ComposerContextId>();
  const entries: string[] = [];
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.contextId)) continue;
    seen.add(occurrence.contextId);
    const record = recordsById.get(occurrence.contextId);
    const entry = formatEnvelopeEntry(
      record?.kind ?? occurrence.kind,
      occurrence.contextId,
      record,
    );
    entries.push(entry);
  }
  if (entries.length === 0) return body;
  return `${body}\n\n<${CONTEXT_ENVELOPE_TAG} version="1">\n${entries.join("\n")}\n</${CONTEXT_ENVELOPE_TAG}>`;
}

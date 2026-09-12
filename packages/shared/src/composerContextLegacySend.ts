import type { ComposerContextRecord, ElementContextDetails } from "@t3tools/contracts";

import { collectComposerContextReferences } from "./composerContextReferences.ts";

/**
 * Serializes a canonical message (inline reference links plus records) into the pre-inline-context
 * wire shape, for servers that do not advertise `inlineMessageContext`. Those servers drop the
 * records and forward the links as literal text, so the payload has to travel inside the message.
 *
 * The output is the format `upgradeLegacyContextMessage` parses, so a newer client reading the
 * resulting message reconstructs the same records.
 */
export function serializeLegacyContextMessage(input: {
  text: string;
  records: ReadonlyArray<ComposerContextRecord>;
}): string {
  const recordsById = new Map(input.records.map((record) => [record.contextId, record]));
  const used = new Set<string>();

  // Inline references become the plain label the old composer wrote; the payload follows in a
  // trailing block, which is where the legacy format carried it.
  let text = input.text;
  const occurrences = collectComposerContextReferences(text);
  for (const occurrence of [...occurrences].reverse()) {
    const record = recordsById.get(occurrence.contextId);
    if (!record) continue;
    used.add(occurrence.contextId);
    const replacement =
      record.kind === "review-comment" ? renderReviewComment(record) : inlineLabel(record);
    text = `${text.slice(0, occurrence.start)}${replacement}${text.slice(occurrence.end)}`;
  }

  const blocks = [
    renderBlock(
      "terminal_context",
      input.records.filter((record) => record.kind === "terminal").map(renderTerminalEntry),
    ),
    renderBlock(
      "element_context",
      input.records.filter((record) => record.kind === "element").map(renderElementEntry),
    ),
    ...input.records
      .filter((record) => record.kind === "preview-annotation")
      .map((record) => `<preview_annotation>\n${renderPreviewBody(record)}\n</preview_annotation>`),
    ...input.records
      .filter((record) => record.kind === "review-comment" && !used.has(record.contextId))
      .map(renderReviewComment),
  ].filter((block) => block.length > 0);

  // Review comments already inlined their payload above; anything else unreferenced still ships
  // its block so no context is silently dropped.
  return [text.trimEnd(), ...blocks].filter((part) => part.length > 0).join("\n\n");
}

function inlineLabel(record: ComposerContextRecord): string {
  if (record.kind === "terminal" && "terminalLabel" in record) {
    const slug = record.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
    const range =
      record.lineStart === record.lineEnd
        ? `${record.lineStart}`
        : `${record.lineStart}-${record.lineEnd}`;
    return `@${slug}:${range}`;
  }
  return record.label;
}

function renderBlock(tag: string, entries: ReadonlyArray<string>): string {
  const body = entries.filter((entry) => entry.length > 0).join("\n");
  return body.length === 0 ? "" : `<${tag}>\n${body}\n</${tag}>`;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `  ${line}`))
    .join("\n");
}

function renderTerminalEntry(record: ComposerContextRecord): string {
  if (!("terminalLabel" in record)) return "";
  const range =
    record.lineStart === record.lineEnd
      ? `line ${record.lineStart}`
      : `lines ${record.lineStart}-${record.lineEnd}`;
  const body = record.text
    .split("\n")
    // A trailing newline would otherwise number a line past the range the label declares.
    .slice(0, record.lineEnd - record.lineStart + 1)
    .map((line, index) => `${record.lineStart + index} | ${line}`)
    .join("\n");
  return `- ${record.terminalLabel} ${range}:\n${indent(body)}`;
}

function renderElementEntry(record: ComposerContextRecord): string {
  if (!("tagName" in record)) return "";
  return renderElementDetailsEntry(record);
}

function renderElementDetailsEntry(record: ElementContextDetails): string {
  const lines: string[] = [];
  if (record.pageUrl) lines.push(`url: ${record.pageUrl}`);
  if (record.selector) lines.push(`selector: ${record.selector}`);
  const source = record.source;
  if (source?.fileName) {
    const position = [source.lineNumber, source.columnNumber].filter(
      (part) => part !== null && part !== undefined,
    );
    lines.push(`source: ${[source.fileName, ...position].join(":")}`);
  }
  if (record.htmlPreview) lines.push(`html:\n${indent(record.htmlPreview)}`);
  if (record.styles) lines.push(`styles:\n${indent(record.styles)}`);
  return `- <${record.componentName ?? record.tagName}>:\n${indent(lines.join("\n"))}`;
}

function renderPreviewBody(record: ComposerContextRecord): string {
  if (!("annotationId" in record)) return "";
  const lines = [`Id: ${record.annotationId}`, `Page: ${record.pageUrl || record.pageTitle || ""}`];
  if (record.comment) lines.push(`Comment: ${record.comment}`);
  if (record.targetSummary) lines.push(`Targets: ${record.targetSummary}`);
  if (record.styleChanges.length > 0) {
    lines.push("Requested visual changes:", ...record.styleChanges.map((change) => `- ${change}`));
  }
  if (record.elements && record.elements.length > 0) {
    lines.push(
      "<element_context>",
      record.elements.map(renderElementDetailsEntry).join("\n"),
      "</element_context>",
    );
  }
  return lines.join("\n");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderReviewComment(record: ComposerContextRecord): string {
  if (!("sectionId" in record)) return record.label;
  const attributes = [
    `sectionId="${escapeAttribute(record.sectionId)}"`,
    `sectionTitle="${escapeAttribute(record.sectionTitle)}"`,
    `filePath="${escapeAttribute(record.filePath)}"`,
    `rangeLabel="${escapeAttribute(record.rangeLabel)}"`,
    `startIndex="${record.startIndex}"`,
    `endIndex="${record.endIndex}"`,
  ].join(" ");
  // The fence must be longer than any run of backticks inside the diff so the body stays intact.
  const longestRun = Math.max(
    0,
    ...[...record.diff.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = record.diff
    ? `${record.text}\n\n${fence}${record.fenceLanguage ?? "diff"}\n${record.diff}\n${fence}`
    : record.text;
  return `<review_comment ${attributes}>\n${body}\n</review_comment>`;
}

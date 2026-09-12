import {
  type ComposerContextId,
  ComposerContextRecord,
  type ElementContextRecord,
  type PreviewAnnotationContextRecord,
  ReviewCommentContextRecord,
  type TerminalContextRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { formatComposerContextReference } from "./composerContextReferences.ts";

/**
 * Upgrades a message written before inline context references: trailing
 * `<terminal_context>`, `<element_context>` and `<preview_annotation>` blocks, inline or
 * trailing `<review_comment>` blocks, and U+FFFC terminal placeholders. Produces canonical
 * reference links plus records so old messages render and copy through the new path.
 * Event history is never rewritten; this runs in memory on read.
 */

export interface UpgradedLegacyContext {
  text: string;
  records: ComposerContextRecord[];
}

const PLACEHOLDER = "￼";
const TRAILING_TERMINAL = /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;
const TRAILING_ELEMENT = /\n*<element_context>\n([\s\S]*?)\n<\/element_context>\s*$/;
const TRAILING_PREVIEW =
  /\n*<preview_annotation>\n((?:(?!\n<\/preview_annotation>)[\s\S])*)\n<\/preview_annotation>\s*$/;
const REVIEW_OR_CONTEXT_BLOCK =
  /<review_comment\b([^>]*)>|^<(terminal_context|element_context|preview_annotation)>\n[\s\S]*?\n<\/\2>/gm;
const REVIEW_ATTRIBUTE = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const REVIEW_FENCE = /(`{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n\1/g;
const REVIEW_TOKEN = "\uE000";
const LEGACY_MARKERS =
  /<(?:terminal_context|element_context|preview_annotation|review_comment)\b|￼/;
const isReviewCommentContextRecord = Schema.is(ReviewCommentContextRecord);
const isLegacyContextRecords = Schema.is(
  Schema.Array(ComposerContextRecord).check(Schema.isMaxLength(200)),
);

interface ParsedEntry {
  header: string;
  body: string;
}

function parseEntries(block: string): ParsedEntry[] | null {
  const entries: ParsedEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;
  const commit = () => {
    if (!current) return;
    entries.push({ header: current.header, body: current.bodyLines.join("\n").trimEnd() });
    current = null;
  };
  for (const line of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(line);
    if (headerMatch) {
      commit();
      current = { header: headerMatch[1]!, bodyLines: [] };
      continue;
    }
    if (current && line.startsWith("  ")) current.bodyLines.push(line.slice(2));
    else if (line.trim().length > 0) return null;
    else if (current) current.bodyLines.push("");
  }
  commit();
  return entries;
}

/** The inline label the old send path wrote for a terminal excerpt: `@terminal-1:509-514`. */
function inlineTerminalLabel(record: TerminalContextRecord): string {
  const slug = record.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const range =
    record.lineStart === record.lineEnd
      ? `${record.lineStart}`
      : `${record.lineStart}-${record.lineEnd}`;
  return `@${slug}:${range}`;
}

function legacyId(kind: string, index: number): ComposerContextId {
  return `legacy_${kind}_${index}` as ComposerContextId;
}

function terminalRecord(entry: ParsedEntry, index: number): TerminalContextRecord | null {
  const header = /^(.*?) (?:line (\d+)|lines (\d+)-(\d+))$/.exec(entry.header);
  if (!header) return null;
  const terminalLabel = header[1]!.trim();
  if (!terminalLabel) return null;
  const lineStart = Number(header[2] ?? header[3]);
  const lineEnd = Number(header[2] ?? header[4]);
  const text = entry.body
    .split("\n")
    .map((line) => line.replace(/^\d+ \| ?/, ""))
    .join("\n");
  return {
    version: 1,
    contextId: legacyId("terminal", index),
    kind: "terminal",
    label: entry.header,
    terminalId: terminalLabel.toLowerCase().replace(/\s+/g, "-"),
    terminalLabel,
    lineStart,
    lineEnd,
    text,
  };
}

function parseSource(location: string): ElementContextRecord["source"] {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(location);
  if (!match || !match[1]) return null;
  return {
    functionName: null,
    fileName: match[1],
    lineNumber: match[2] === undefined ? null : Number(match[2]),
    columnNumber: match[3] === undefined ? null : Number(match[3]),
  };
}

function elementRecord(entry: ParsedEntry, index: number): ElementContextRecord | null {
  const header = /^<([^>]+)>/.exec(entry.header);
  if (!header) return null;
  const inner = header[1]!;
  const fields: Record<string, string> = {};
  const sections: Record<string, string[]> = {};
  let section: string | null = null;
  for (const line of entry.body.split("\n")) {
    if (section && (line.startsWith("  ") || line.length === 0)) {
      sections[section]!.push(line.slice(2));
      continue;
    }
    section = null;
    const field = /^([a-z]+): (.*)$/.exec(line);
    if (field) {
      fields[field[1]!] = field[2]!;
      continue;
    }
    const sectionStart = /^(html|styles):$/.exec(line);
    if (sectionStart) {
      section = sectionStart[1]!;
      sections[section] = [];
    }
  }
  return {
    version: 1,
    contextId: legacyId("element", index),
    kind: "element",
    label: `<${inner}>`,
    pageUrl: fields.url ?? "",
    pageTitle: null,
    tagName: inner.toLowerCase(),
    selector: fields.selector ?? null,
    htmlPreview: (sections.html ?? []).join("\n").trimEnd(),
    componentName: /[A-Z]/.test(inner) ? inner : null,
    source: fields.source ? parseSource(fields.source) : null,
    styles: (sections.styles ?? []).join("\n").trimEnd(),
  };
}

function previewRecord(body: string, index: number): PreviewAnnotationContextRecord | null {
  const lines = body.split("\n");
  // A legacy comment was written verbatim, so it can run over several lines and hold blank
  // lines and markup of its own. Its value is every line up to the next field or the block that
  // follows it — anything else is text the author typed, and dropping it loses instructions the
  // chip that replaces this block cannot show.
  const FIELD_PREFIXES = ["Preview annotation:", "Id: ", "Page: ", "Comment: ", "Targets: "];
  const BLOCK_DELIMITER =
    /^<\/?(?:terminal_context|element_context|preview_annotation|review_comment)\b/;
  const isFieldStart = (line: string) =>
    FIELD_PREFIXES.some((candidate) => line.startsWith(candidate)) ||
    line === "Requested visual changes:" ||
    BLOCK_DELIMITER.test(line) ||
    line === "The attached screenshot is the annotated preview crop.";
  const read = (prefix: string) => {
    const start = lines.findIndex((line) => line.startsWith(prefix));
    if (start < 0) return "";
    let end = start + 1;
    while (end < lines.length && !isFieldStart(lines[end]!)) end += 1;
    return [lines[start]!.slice(prefix.length), ...lines.slice(start + 1, end)].join("\n").trim();
  };
  const styleHeading = lines.indexOf("Requested visual changes:");
  const styleChanges: string[] = [];
  if (styleHeading >= 0) {
    for (const line of lines.slice(styleHeading + 1)) {
      if (!line.startsWith("- ")) break;
      styleChanges.push(line.slice(2));
    }
  }
  const page = read("Page: ");
  const pageIsUrl = /^https?:\/\//i.test(page);
  const elements: NonNullable<PreviewAnnotationContextRecord["elements"]>[number][] = [];
  for (const match of body.matchAll(/<element_context>\n([\s\S]*?)\n<\/element_context>/g)) {
    const entries = parseEntries(match[1] ?? "");
    if (entries === null) return null;
    for (const entry of entries) {
      const record = elementRecord(entry, elements.length + 1);
      if (record === null) return null;
      const {
        version: _version,
        contextId: _contextId,
        kind: _kind,
        label: _label,
        ...details
      } = record;
      elements.push(details);
    }
  }
  return {
    version: 1,
    contextId: legacyId("preview-annotation", index),
    kind: "preview-annotation",
    label: page || "Preview annotation",
    annotationId: read("Id: "),
    pageUrl: pageIsUrl ? page : (elements[0]?.pageUrl ?? ""),
    pageTitle: pageIsUrl ? null : page || null,
    comment: read("Comment: "),
    targetSummary: read("Targets: "),
    styleChanges,
    ...(elements.length > 0 ? { elements } : {}),
  };
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function reviewRecord(
  rawAttributes: string,
  rawBody: string,
  index: number,
): ReviewCommentContextRecord | null {
  const attributes: Record<string, string> = {};
  for (const match of rawAttributes.matchAll(REVIEW_ATTRIBUTE)) {
    attributes[match[1]!] = unescapeAttribute(match[2] ?? "");
  }
  const filePath = attributes.filePath?.trim();
  const sectionId = attributes.sectionId?.trim();
  const startIndex = attributes.startIndex;
  const endIndex = attributes.endIndex;
  if (!filePath || !sectionId || !/^\d+$/.test(startIndex ?? "") || !/^\d+$/.test(endIndex ?? "")) {
    return null;
  }
  const fences = Array.from(rawBody.matchAll(REVIEW_FENCE));
  const fence = fences.at(-1);
  const rangeLabel = attributes.rangeLabel?.trim() || "line";
  const basename = filePath.split(/[\\/]/).at(-1) ?? filePath;
  return {
    version: 1,
    contextId: legacyId("review-comment", index),
    kind: "review-comment",
    label: `${basename} ${rangeLabel}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    startIndex: Math.min(Number(startIndex), Number(endIndex)),
    endIndex: Math.max(Number(startIndex), Number(endIndex)),
    rangeLabel,
    text: rawBody.slice(0, fence?.index ?? rawBody.length).trim(),
    diff: fence?.[3] ?? "",
    fenceLanguage: fence?.[2]?.trim() || "diff",
  };
}

function stripTrailing(
  text: string,
  pattern: RegExp,
): { text: string; match: RegExpExecArray } | null {
  const match = pattern.exec(text);
  if (!match) return null;
  return { text: text.slice(0, match.index).replace(/\n+$/, ""), match };
}

/** Review source can contain literal closing tags inside its dynamically sized code fence. */
function replaceReviewBlocks(
  text: string,
  replace: (whole: string, attributes: string, body: string) => string,
): string {
  const parts: string[] = [];
  const openings = new RegExp(REVIEW_OR_CONTEXT_BLOCK);
  let consumed = 0;
  for (let opening = openings.exec(text); opening; opening = openings.exec(text)) {
    // Other context blocks own their payload, including any review-shaped source text.
    if (opening[2]) continue;
    const bodyStart = openings.lastIndex;
    const boundaries = /^(`{3,})([^\n]*)$|<\/review_comment>/gm;
    boundaries.lastIndex = bodyStart;
    let fenceLength = 0;
    for (let boundary = boundaries.exec(text); boundary; boundary = boundaries.exec(text)) {
      if (boundary[1]) {
        if (fenceLength === 0) fenceLength = boundary[1].length;
        else if (boundary[1].length >= fenceLength && !boundary[2]?.trim()) fenceLength = 0;
      } else if (fenceLength === 0) {
        parts.push(text.slice(consumed, opening.index));
        consumed = boundaries.lastIndex;
        parts.push(
          replace(
            text.slice(opening.index, consumed),
            opening[1]!,
            text.slice(bodyStart, boundary.index),
          ),
        );
        openings.lastIndex = consumed;
        break;
      }
    }
    if (consumed < bodyStart) break;
  }
  parts.push(text.slice(consumed));
  return parts.join("");
}

export function upgradeLegacyContextMessage(text: string): UpgradedLegacyContext {
  if (!LEGACY_MARKERS.test(text)) return { text, records: [] };

  const terminalEntries: ParsedEntry[] = [];
  const elementEntries: ParsedEntry[] = [];
  const previewBodies: string[] = [];
  const reviews: ReviewCommentContextRecord[] = [];

  // A literal private-use token in the message must never be mistaken for our placeholder.
  let reviewToken = REVIEW_TOKEN;
  while (text.includes(reviewToken)) reviewToken += reviewToken;
  const reviewTokenPattern = new RegExp(`${reviewToken}(\\d+)${reviewToken}`, "g");
  const trailingReviewTokenPattern = new RegExp(`(?:\\s*${reviewToken}\\d+${reviewToken})+\\s*$`);

  // Review blocks become tokens in place first so they neither hide the trailing blocks
  // behind them nor lose their position. Unparseable blocks stay as text.
  let rest = replaceReviewBlocks(text, (whole, attributes, rawBody) => {
    const record = reviewRecord(attributes, rawBody, reviews.length + 1);
    // Keep the original prose if converting it would produce a record the wire drops.
    if (!record || !isReviewCommentContextRecord(record)) return whole;
    reviews.push(record);
    return `${reviewToken}${reviews.length - 1}${reviewToken}`;
  });

  // Blocks were appended in send order (terminal, element, preview, review), so they peel
  // off the end in reverse. Each peel exposes the next block as trailing.
  // Only reviews that trailed the original text were appended by the old send path; a
  // review that sat before other blocks keeps its place.
  const trailingReviewTokens: number[] = [];
  const tokens = trailingReviewTokenPattern.exec(rest);
  if (tokens && tokens[0].length > 0) {
    trailingReviewTokens.push(
      ...Array.from(tokens[0].matchAll(reviewTokenPattern), (m) => Number(m[1])),
    );
    rest = rest.slice(0, tokens.index).replace(/\n+$/, "");
  }
  for (;;) {
    const preview = stripTrailing(rest, TRAILING_PREVIEW);
    if (preview) {
      rest = preview.text;
      previewBodies.unshift(preview.match[1] ?? "");
      continue;
    }
    const element = stripTrailing(rest, TRAILING_ELEMENT);
    if (element) {
      const entries = parseEntries(element.match[1] ?? "");
      if (!entries?.length || entries.some((entry) => elementRecord(entry, 1) === null))
        return { text, records: [] };
      rest = element.text;
      elementEntries.unshift(...entries);
      continue;
    }
    const terminal = stripTrailing(rest, TRAILING_TERMINAL);
    if (terminal) {
      const entries = parseEntries(terminal.match[1] ?? "");
      if (!entries?.length || entries.some((entry) => terminalRecord(entry, 1) === null))
        return { text, records: [] };
      rest = terminal.text;
      terminalEntries.unshift(...entries);
      continue;
    }
    break;
  }

  const terminals = terminalEntries
    .map((entry, index) => terminalRecord(entry, index + 1))
    .filter((record) => record !== null);
  const elements = elementEntries
    .map((entry, index) => elementRecord(entry, index + 1))
    .filter((record) => record !== null);
  const previews: PreviewAnnotationContextRecord[] = [];
  for (const [index, previewBody] of previewBodies.entries()) {
    const record = previewRecord(previewBody, index + 1);
    if (record === null) return { text, records: [] };
    previews.push(record);
  }
  const appendedReviews = trailingReviewTokens.map((index) => reviews[index]!);

  let body = rest.replace(reviewTokenPattern, (_whole, index: string) =>
    formatComposerContextReference(reviews[Number(index)]!),
  );

  // Placeholders bind to terminal entries in order, like the old materialize step did.
  let placeholderIndex = 0;
  body = body.replace(new RegExp(PLACEHOLDER, "g"), () => {
    const record = terminals[placeholderIndex];
    placeholderIndex += 1;
    return record ? formatComposerContextReference(record) : "";
  });
  // Sent messages carry the materialized `@terminal-1:509-514` label instead of the
  // placeholder; each such label becomes the chip in place.
  const placedTerminals = new Set(terminals.slice(0, placeholderIndex));
  for (const record of terminals) {
    if (placedTerminals.has(record)) continue;
    const label = inlineTerminalLabel(record);
    let at = body.indexOf(label);
    while (
      at !== -1 &&
      (/[\p{L}\p{N}\p{M}_@.-]$/u.test(body.slice(0, at)) ||
        /^(?:[\p{L}\p{N}\p{M}_-]|[.@]+[\p{L}\p{N}\p{M}_-])/u.test(body.slice(at + label.length)))
    ) {
      at = body.indexOf(label, at + 1);
    }
    if (at === -1) continue;
    body = `${body.slice(0, at)}${formatComposerContextReference(record)}${body.slice(at + label.length)}`;
    placedTerminals.add(record);
  }
  body = body.trimEnd();

  const appended = [
    ...terminals.filter((record) => !placedTerminals.has(record)),
    ...elements,
    ...previews,
    ...appendedReviews,
  ].map((record) => formatComposerContextReference(record));
  const upgradedText =
    appended.length === 0
      ? body
      : body.length > 0
        ? `${body}\n\n${appended.join(" ")}`
        : appended.join(" ");

  const records = [...terminals, ...elements, ...previews, ...reviews];
  // Conversion is atomic: keep the source if any record would be dropped on the wire.
  if (!isLegacyContextRecords(records)) return { text, records: [] };
  return {
    text: upgradedText,
    records,
  };
}

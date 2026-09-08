import * as Schema from "effect/Schema";

const ReviewCommentSelectionSchema = Schema.Struct({
  start: Schema.Number,
  side: Schema.Literals(["additions", "deletions"]),
  end: Schema.Number,
  endSide: Schema.Literals(["additions", "deletions"]),
});
type ReviewCommentSelection = typeof ReviewCommentSelectionSchema.Type;

export const ReviewCommentContextSchema = Schema.Struct({
  id: Schema.String,
  sectionId: Schema.String,
  sectionTitle: Schema.String,
  filePath: Schema.String,
  startIndex: Schema.Number,
  endIndex: Schema.Number,
  rangeLabel: Schema.String,
  text: Schema.String,
  diff: Schema.String,
  fenceLanguage: Schema.optional(Schema.String),
  selection: Schema.optional(ReviewCommentSelectionSchema),
});

export interface ReviewCommentContext {
  readonly id: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly text: string;
  readonly diff: string;
  readonly fenceLanguage?: string | undefined;
  readonly selection?: ReviewCommentSelection | undefined;
}

export type ReviewCommentMessageSegment =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "review-comment";
      readonly comment: ReviewCommentContext;
    };

const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
const REVIEW_COMMENT_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const REVIEW_COMMENT_FENCE_PATTERN = /(`{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n\1/g;

function unescapeReviewCommentAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function readReviewCommentAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of rawAttributes.matchAll(REVIEW_COMMENT_ATTRIBUTE_PATTERN)) {
    attributes[match[1]!] = unescapeReviewCommentAttribute(match[2] ?? "");
  }
  return attributes;
}

function readNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function extractReviewCommentBody(rawBody: string): {
  text: string;
  language: string;
  contents: string;
} {
  const matches = Array.from(rawBody.matchAll(REVIEW_COMMENT_FENCE_PATTERN));
  const match = matches.at(-1);
  const fenceIndex = match?.index;
  return {
    text: rawBody.slice(0, fenceIndex ?? rawBody.length).trim(),
    language: match?.[2]?.trim() || "diff",
    contents: match?.[3] ?? "",
  };
}

function parseReviewCommentContext(
  rawAttributes: string,
  rawBody: string,
  index: number,
): ReviewCommentContext | null {
  const attributes = readReviewCommentAttributes(rawAttributes);
  const startIndex = readNonNegativeInteger(attributes.startIndex);
  const endIndex = readNonNegativeInteger(attributes.endIndex);
  const filePath = attributes.filePath?.trim();
  const sectionId = attributes.sectionId?.trim();
  if (!filePath || !sectionId || startIndex === null || endIndex === null) {
    return null;
  }
  const body = extractReviewCommentBody(rawBody);

  return {
    id: `review-comment:${index}:${sectionId}:${filePath}:${startIndex}:${endIndex}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
    rangeLabel: attributes.rangeLabel?.trim() || "line",
    text: body.text,
    diff: body.contents,
    fenceLanguage: body.language,
  };
}

export function parseReviewCommentMessageSegments(
  value: string,
): ReadonlyArray<ReviewCommentMessageSegment> {
  const segments: ReviewCommentMessageSegment[] = [];
  let cursor = 0;
  let parsedCommentIndex = 0;

  for (const match of value.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const beforeText = value.slice(cursor, matchIndex);
    if (beforeText.length > 0) {
      segments.push({
        kind: "text",
        id: `review-comment-text:${cursor}`,
        text: beforeText,
      });
    }

    const comment = parseReviewCommentContext(match[1] ?? "", match[2] ?? "", parsedCommentIndex);
    if (comment) {
      segments.push({ kind: "review-comment", comment });
      parsedCommentIndex += 1;
    } else {
      segments.push({
        kind: "text",
        id: `review-comment-invalid:${matchIndex}`,
        text: match[0],
      });
    }

    cursor = matchIndex + match[0].length;
  }

  const rest = value.slice(cursor);
  if (rest.length > 0) {
    segments.push({
      kind: "text",
      id: `review-comment-text:${cursor}`,
      text: rest,
    });
  }

  return segments;
}

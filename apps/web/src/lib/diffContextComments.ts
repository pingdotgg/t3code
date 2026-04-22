import { type ThreadId, type TurnId } from "@t3tools/contracts";
import {
  appendPromptContextBlock,
  buildPromptContextBlock,
  extractTrailingPromptContextBlock,
  type PromptContextBlockEntry,
} from "./promptContextBlock";

export type DiffContextCommentSide = "additions" | "deletions";

export interface DiffContextCommentDraft {
  id: string;
  threadId: ThreadId;
  turnId: TurnId | null;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: DiffContextCommentSide;
  body: string;
  createdAt: string;
}

export interface DiffContextCommentDraftUpdate {
  body: string;
}

export interface ExtractedDiffContextComments {
  promptText: string;
  commentCount: number;
  previewTitle: string | null;
  comments: ParsedDiffContextCommentEntry[];
}

export type ParsedDiffContextCommentEntry = PromptContextBlockEntry;

const DIFF_CONTEXT_COMMENTS_BLOCK_TAG = "diff_context_comments";
export const INLINE_DIFF_CONTEXT_COMMENT_PLACEHOLDER = "\uE000";

function formatSideLabel(side: DiffContextCommentSide): string {
  return side === "deletions" ? "-" : "+";
}

export function formatDiffContextCommentRange(comment: {
  lineStart: number;
  lineEnd: number;
  side: DiffContextCommentSide;
}): string {
  const prefix = formatSideLabel(comment.side);
  return comment.lineStart === comment.lineEnd
    ? `${prefix}${comment.lineStart}`
    : `${prefix}${comment.lineStart}-${comment.lineEnd}`;
}

export function formatDiffContextCommentLabel(comment: {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: DiffContextCommentSide;
}): string {
  return `${comment.filePath}:${formatDiffContextCommentRange(comment)}`;
}

export function formatInlineDiffContextCommentLabel(
  comment:
    | {
        filePath: string;
        lineStart: number;
        lineEnd: number;
        side: DiffContextCommentSide;
      }
    | string,
): string {
  const label = typeof comment === "string" ? comment : formatDiffContextCommentLabel(comment);
  return `@diff:${label}`;
}

function normalizeCommentBody(body: string): string {
  return body.trim();
}

export function buildDiffContextCommentsPreviewTitle(
  comments: ReadonlyArray<DiffContextCommentDraft>,
): string | null {
  if (comments.length === 0) {
    return null;
  }

  return comments
    .map((comment) => `${formatDiffContextCommentLabel(comment)}\n${comment.body.trim()}`)
    .join("\n\n");
}

export function buildDiffContextCommentsBlock(
  comments: ReadonlyArray<DiffContextCommentDraft>,
): string {
  if (comments.length === 0) {
    return "";
  }

  return buildPromptContextBlock(
    DIFF_CONTEXT_COMMENTS_BLOCK_TAG,
    comments.map((comment) => ({
      header: formatDiffContextCommentLabel(comment),
      bodyLines: normalizeCommentBody(comment.body)
        .split("\n")
        .map((line) => `  ${line}`),
    })),
  );
}

export function appendDiffContextCommentsToPrompt(
  prompt: string,
  comments: ReadonlyArray<DiffContextCommentDraft>,
): string {
  const materializedPrompt = materializeInlineDiffContextCommentPrompt(prompt, comments);
  const commentBlock = buildDiffContextCommentsBlock(comments);

  return appendPromptContextBlock(materializedPrompt, commentBlock);
}

export function extractTrailingDiffContextComments(prompt: string): ExtractedDiffContextComments {
  const extracted = extractTrailingPromptContextBlock(prompt, DIFF_CONTEXT_COMMENTS_BLOCK_TAG, {
    allowSingleLineEntries: true,
  });

  return {
    promptText: extracted.promptText,
    commentCount: extracted.entries.length,
    previewTitle: extracted.previewTitle,
    comments: extracted.entries,
  };
}

export function materializeInlineDiffContextCommentPrompt(
  prompt: string,
  comments: ReadonlyArray<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
    side: DiffContextCommentSide;
  }>,
): string {
  let nextCommentIndex = 0;
  let result = "";

  for (const char of prompt) {
    if (char !== INLINE_DIFF_CONTEXT_COMMENT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const comment = comments[nextCommentIndex] ?? null;
    nextCommentIndex += 1;
    if (!comment) {
      continue;
    }
    result += formatInlineDiffContextCommentLabel(comment);
  }

  return result;
}

export function countInlineDiffContextCommentPlaceholders(prompt: string): number {
  let count = 0;
  for (const char of prompt) {
    if (char === INLINE_DIFF_CONTEXT_COMMENT_PLACEHOLDER) {
      count += 1;
    }
  }
  return count;
}

export function ensureInlineDiffContextCommentPlaceholders(
  prompt: string,
  diffContextCommentCount: number,
): string {
  const missingCount = diffContextCommentCount - countInlineDiffContextCommentPlaceholders(prompt);
  if (missingCount <= 0) {
    return prompt;
  }
  return `${INLINE_DIFF_CONTEXT_COMMENT_PLACEHOLDER.repeat(missingCount)}${prompt}`;
}

export function stripInlineDiffContextCommentPlaceholders(prompt: string): string {
  return prompt.replaceAll(INLINE_DIFF_CONTEXT_COMMENT_PLACEHOLDER, "");
}

export function removeInlineDiffContextCommentPlaceholder(
  prompt: string,
  contextIndex: number,
): { prompt: string; cursor: number } {
  let seenCount = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_DIFF_CONTEXT_COMMENT_PLACEHOLDER) {
      continue;
    }
    if (seenCount === contextIndex) {
      const nextChar = prompt[index + 1];
      const removeEnd = nextChar === " " ? index + 2 : index + 1;
      return {
        prompt: prompt.slice(0, index) + prompt.slice(removeEnd),
        cursor: index,
      };
    }
    seenCount += 1;
  }
  return { prompt, cursor: prompt.length };
}

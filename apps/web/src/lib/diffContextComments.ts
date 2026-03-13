import { type ThreadId, type TurnId } from "@t3tools/contracts";

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
}

const TRAILING_DIFF_CONTEXT_COMMENTS_BLOCK_PATTERN =
  /\n*<diff_context_comments>\n([\s\S]*?)\n<\/diff_context_comments>\s*$/;

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

  const lines = comments.flatMap((comment, index) => {
    const scope = formatDiffContextCommentLabel(comment);
    const bodyLines = normalizeCommentBody(comment.body)
      .split("\n")
      .map((line) => `  ${line}`);

    return [`- ${scope}:`, ...bodyLines, ...(index < comments.length - 1 ? [""] : [])];
  });

  return ["<diff_context_comments>", ...lines, "</diff_context_comments>"].join("\n");
}

export function appendDiffContextCommentsToPrompt(
  prompt: string,
  comments: ReadonlyArray<DiffContextCommentDraft>,
): string {
  const trimmedPrompt = prompt.trim();
  const commentBlock = buildDiffContextCommentsBlock(comments);

  if (commentBlock.length === 0) {
    return trimmedPrompt;
  }

  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${commentBlock}` : commentBlock;
}

export function extractTrailingDiffContextComments(prompt: string): ExtractedDiffContextComments {
  const match = TRAILING_DIFF_CONTEXT_COMMENTS_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      commentCount: 0,
      previewTitle: null,
    };
  }

  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const parsedComments = parseDiffContextCommentEntries(match[1] ?? "");

  return {
    promptText,
    commentCount: parsedComments.length,
    previewTitle:
      parsedComments.length > 0
        ? parsedComments
            .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
            .join("\n\n")
        : null,
  };
}

function parseDiffContextCommentEntries(block: string): Array<{ header: string; body: string }> {
  const entries: Array<{ header: string; body: string }> = [];
  let current: { header: string; bodyLines: string[] } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }

    entries.push({
      header: current.header,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const singleLineMatch = /^- (.+?): (.+)$/.exec(rawLine);
    if (singleLineMatch) {
      commitCurrent();
      entries.push({
        header: singleLineMatch[1]!,
        body: singleLineMatch[2]!,
      });
      continue;
    }

    const blockHeaderMatch = /^- (.+?):$/.exec(rawLine);
    if (blockHeaderMatch) {
      commitCurrent();
      current = {
        header: blockHeaderMatch[1]!,
        bodyLines: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (rawLine.startsWith("  ")) {
      current.bodyLines.push(rawLine.slice(2));
      continue;
    }

    if (rawLine.length === 0) {
      current.bodyLines.push("");
    }
  }

  commitCurrent();

  return entries;
}

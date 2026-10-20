import { resolvedReviewCommentsLabel } from "@t3tools/client-runtime/review-editing";
export { reviewPositionLabel } from "@t3tools/client-runtime/review-selection";
import {
  reviewPositionLabel,
  reviewLineRangeLabel,
} from "@t3tools/client-runtime/review-selection";
import type { PullRequestReviewPosition, PullRequestReviewThread } from "@t3tools/contracts";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import type { PendingReviewComment } from "./pullRequestReviewDrafts";

export function reviewPosition(row: NativeReviewDiffRow): PullRequestReviewPosition | null {
  if (row.kind !== "line") return null;
  if (row.change === "add" && row.newLineNumber)
    return { kind: "added", newLine: row.newLineNumber };
  if (row.change === "delete" && row.oldLineNumber)
    return { kind: "deleted", oldLine: row.oldLineNumber };
  if (row.oldLineNumber && row.newLineNumber)
    return {
      kind: "context",
      oldLine: row.oldLineNumber,
      newLine: row.newLineNumber,
      side: "right",
    };
  return null;
}
function reviewLine(position: PullRequestReviewPosition) {
  if (position.kind === "deleted" || (position.kind === "context" && position.side === "left"))
    return position.oldLine;
  return position.newLine;
}
export function annotatePullRequestDiff(
  data: NativeReviewDiffData,
  threads: readonly PullRequestReviewThread[],
  drafts: readonly PendingReviewComment[],
  headSha: string | undefined,
): NativeReviewDiffData {
  const anchors = new Map<string, NativeReviewDiffRow[]>();
  const firstByPath = new Map<string, NativeReviewDiffRow>();
  const lines = new Map<string, NativeReviewDiffRow>();
  const paths = new Map(data.files.map((file) => [file.id, file.path]));
  for (const original of data.rows) {
    const row = {
      ...original,
      filePath: original.filePath ?? (original.fileId ? paths.get(original.fileId) : undefined),
    };
    if (row.kind === "file" && row.filePath) firstByPath.set(row.filePath, row);
    if (row.kind !== "line" || !row.filePath) continue;
    if (row.oldLineNumber)
      lines.set(JSON.stringify([row.filePath, "left", row.oldLineNumber]), row);
    if (row.newLineNumber)
      lines.set(JSON.stringify([row.filePath, "right", row.newLineNumber]), row);
  }
  const attach = (
    anchor: NativeReviewDiffRow | undefined,
    id: string,
    body: string,
    label: string,
    state?: { commentPending?: boolean; commentResolvedSummary?: string },
  ) => {
    if (!anchor) return;
    const rows = anchors.get(anchor.id) ?? [];
    rows.push({
      kind: "comment",
      id,
      fileId: anchor.fileId,
      filePath: anchor.filePath,
      commentText: body,
      commentRangeLabel: label,
      ...state,
    });
    anchors.set(anchor.id, rows);
  };
  for (const thread of threads) {
    if (thread.isOutdated) continue;
    const anchor =
      thread.line === null
        ? firstByPath.get(thread.path)
        : lines.get(JSON.stringify([thread.path, thread.side, thread.line]));
    const first = thread.comments[0];
    attach(
      anchor,
      `discussion:${thread.id}`,
      `${first?.author?.login ?? "Discussion"}${thread.isResolved ? " · Resolved" : ""}\n${first?.body ?? ""}\n${thread.commentCount ?? thread.comments.length} comments · Tap to open`,
      reviewLineRangeLabel(thread),
      thread.isResolved
        ? {
            commentResolvedSummary: resolvedReviewCommentsLabel(
              thread.commentCount ?? thread.comments.length,
              thread.comments.map(
                (comment) => comment.author?.name ?? comment.author?.login ?? "Unknown author",
              ),
            ),
          }
        : undefined,
    );
  }
  for (const draft of drafts) {
    if (draft.headSha !== headSha) continue;
    const side =
      draft.position.kind === "deleted"
        ? "left"
        : draft.position.kind === "context"
          ? draft.position.side
          : "right";
    const line = reviewLine(draft.position);
    attach(
      lines.get(JSON.stringify([draft.path, side, line])),
      `draft:${draft.id}`,
      draft.body,
      reviewPositionLabel(draft.position),
      { commentPending: true },
    );
  }
  return { ...data, rows: data.rows.flatMap((row) => [row, ...(anchors.get(row.id) ?? [])]) };
}

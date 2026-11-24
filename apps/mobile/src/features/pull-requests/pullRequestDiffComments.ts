import type { PullRequestReviewPosition, PullRequestReviewThread } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
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
export function discussionCommentCountLabel(count: number, resolve: MessageResolver = m) {
  return resolve(msg("{count, plural, one {{count} comment} other {{count} comments}}", { count }));
}
export function reviewPositionLabel(
  position: PullRequestReviewPosition,
  resolve: MessageResolver = m,
) {
  const oldSide =
    position.kind === "deleted" || (position.kind === "context" && position.side === "left");
  const line = reviewLine(position);
  return oldSide
    ? resolve(msg("Old line {line}", { line }))
    : resolve(msg("Line {line}", { line }));
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
  resolve: MessageResolver = m,
): NativeReviewDiffData {
  if (threads.length === 0 && drafts.length === 0) return data;
  const anchors = new Map<string, NativeReviewDiffRow[]>();
  const firstByPath = new Map<string, NativeReviewDiffRow>();
  const lines = new Map<string, NativeReviewDiffRow>();
  const paths = new Map(data.files.map((file) => [file.id, file.path]));
  for (const original of data.rows) {
    const row =
      original.filePath !== undefined || !original.fileId
        ? original
        : { ...original, filePath: paths.get(original.fileId) };
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
      `${first?.author?.login ?? resolve(msg("Discussion"))}${
        thread.isResolved
          ? ` · ${resolve(msg("Resolved", { $context: "review thread state" }))}`
          : ""
      }\n${first?.body ?? ""}\n${resolve(
        msg(
          "{count, plural, one {{count} comment · Tap to open} other {{count} comments · Tap to open}}",
          { count: thread.commentCount ?? thread.comments.length },
        ),
      )}`,
      thread.line === null ? "file" : String(thread.line),
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
      `${resolve(msg("Pending review · Tap to edit"))}\n${draft.body}`,
      String(line),
    );
  }
  return { ...data, rows: data.rows.flatMap((row) => [row, ...(anchors.get(row.id) ?? [])]) };
}

import { describe, expect, it } from "vite-plus/test";
import type { PullRequestReviewThread } from "@t3tools/contracts";
import type { NativeReviewDiffData } from "../review/nativeReviewDiffAdapter";
import {
  annotatePullRequestDiff,
  reviewPosition,
  reviewPositionLabel,
} from "./pullRequestDiffComments";
const data: NativeReviewDiffData = {
  rows: [
    { kind: "file", id: "header", fileId: "f", filePath: "a.ts" },
    { kind: "line", id: "old", fileId: "f", change: "delete", oldLineNumber: 2 },
    { kind: "line", id: "new", fileId: "f", change: "add", newLineNumber: 2 },
  ],
  files: [{ id: "f", path: "a.ts", language: "typescript", additions: 1, deletions: 1 }],
  commentTargetsByRowId: new Map(),
  rowIdByCommentLineId: new Map(),
  additions: 1,
  deletions: 1,
};
const thread: PullRequestReviewThread = {
  id: "t",
  path: "a.ts",
  line: 2,
  side: "left",
  isResolved: false,
  isOutdated: false,
  comments: [],
};
describe("PR comments in continuous native diffs", () => {
  it("anchors old/new lines separately despite identical line numbers", () => {
    const annotated = annotatePullRequestDiff(
      data,
      [thread, { ...thread, id: "right", side: "right" }],
      [],
      "abc",
    );
    expect(annotated.rows.map((row) => row.id)).toEqual([
      "header",
      "old",
      "discussion:t",
      "new",
      "discussion:right",
    ]);
  });
  it("displays a persisted host range at its end without losing its start", () => {
    const annotated = annotatePullRequestDiff(
      data,
      [{ ...thread, startLine: 1, startSide: "left" }],
      [],
      "abc",
    );
    expect(annotated.rows.find((row) => row.id === "discussion:t")?.commentRangeLabel).toBe(
      "Old lines 1–2",
    );
  });
  it("keeps outdated and unloaded anchors off the current code", () => {
    const annotated = annotatePullRequestDiff(
      data,
      [
        { ...thread, isOutdated: true },
        { ...thread, id: "missing", path: "b.ts" },
      ],
      [
        {
          id: "draft",
          path: "a.ts",
          position: { kind: "added", newLine: 2 },
          body: "Feedback",
          code: "",
          headSha: "old",
        },
      ],
      "new",
    );
    expect(annotated.rows).toEqual(data.rows);
  });
  it("supports file-level threads and current private drafts without changing code IDs", () => {
    const annotated = annotatePullRequestDiff(
      data,
      [{ ...thread, line: null }],
      [
        {
          id: "draft",
          path: "a.ts",
          position: { kind: "added", newLine: 2 },
          body: "Feedback",
          code: "",
          headSha: "abc",
        },
      ],
      "abc",
    );
    expect(annotated.rows.map((row) => row.id)).toEqual([
      "header",
      "discussion:t",
      "old",
      "new",
      "draft:draft",
    ]);
    expect(annotated.commentTargetsByRowId).toBe(data.commentTargetsByRowId);
  });
  it("does not guess positions for missing lines, notices, or binary files", () => {
    expect(reviewPosition(data.rows[0]!)).toBeNull();
    expect(reviewPosition(data.rows[1]!)).toEqual({ kind: "deleted", oldLine: 2 });
    expect(reviewPosition(data.rows[2]!)).toEqual({ kind: "added", newLine: 2 });
    expect(
      reviewPosition({ kind: "line", id: "context", oldLineNumber: 3, newLineNumber: 4 }),
    ).toEqual({ kind: "context", side: "right", oldLine: 3, newLine: 4 });
  });
  it("uses the old line number for left-side context when the line numbers differ", () => {
    const position = { kind: "context" as const, side: "left" as const, oldLine: 7, newLine: 8 };
    const annotated = annotatePullRequestDiff(
      {
        ...data,
        rows: [
          ...data.rows,
          { kind: "line", id: "context", fileId: "f", oldLineNumber: 7, newLineNumber: 8 },
        ],
      },
      [],
      [{ id: "left", path: "a.ts", position, headSha: "abc", code: "", body: "Feedback" }],
      "abc",
    );
    expect(annotated.rows.at(-1)?.id).toBe("draft:left");
    expect(reviewPositionLabel(position)).toBe("Old line 7");
  });
});

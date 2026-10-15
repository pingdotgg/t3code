import { reviewFileGroup } from "@t3tools/shared/reviewFileClassification";
import type {
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestReviewDecision,
} from "@t3tools/contracts";

/** The host verdict wins; older hosts fall back to the readiness already shown by the client. */
export function pullRequestMergeRequirementsUnmet(input: {
  readonly mergeRequirementsSatisfied?: boolean | undefined;
  readonly checks: ReadonlyArray<Pick<PullRequestCheck, "status">>;
  readonly checksState?: PullRequestChecksState | null | undefined;
  readonly reviewDecision?: PullRequestReviewDecision | null | undefined;
  readonly baseBehind: boolean;
}) {
  if (input.mergeRequirementsSatisfied !== undefined) return !input.mergeRequirementsSatisfied;
  const checksUnmet =
    input.checksState === undefined
      ? input.checks.some(
          (check) =>
            check.status === "failure" ||
            check.status === "cancelled" ||
            check.status === "pending" ||
            check.status === "action-required",
        )
      : input.checksState === "failing" || input.checksState === "pending";
  return (
    checksUnmet ||
    input.reviewDecision === "review-required" ||
    input.reviewDecision === "changes-requested" ||
    input.baseBehind
  );
}

export interface ReviewRenameSegment {
  readonly text: string;
  readonly kind: "unchanged" | "removed" | "added" | "context";
}

/** Inline filename changes followed by directory context, shared by every review surface. */
export function reviewRenameSegments(previousPath: string, path: string, directory = true) {
  const split = (value: string) => {
    const slash = value.lastIndexOf("/");
    return { name: value.slice(slash + 1), directory: value.slice(0, Math.max(0, slash)) };
  };
  const previous = split(previousPath);
  const next = split(path);
  const parts: ReviewRenameSegment[] = [];
  const append = (text: string, kind: ReviewRenameSegment["kind"] = "unchanged") => {
    if (text) parts.push({ text, kind });
  };
  const changed = (oldText: string, newText: string, context = false) => {
    if (oldText === newText) return append(newText, context ? "context" : "unchanged");
    const oldChars = Array.from(oldText);
    const newChars = Array.from(newText);
    let start = 0;
    let end = 0;
    while (
      start < Math.min(oldChars.length, newChars.length) &&
      oldChars[start] === newChars[start]
    )
      start++;
    while (
      end < Math.min(oldChars.length, newChars.length) - start &&
      oldChars.at(-end - 1) === newChars.at(-end - 1)
    )
      end++;
    const name = (chars: string[], kind: "removed" | "added") => {
      append(chars.slice(0, start).join(""), context ? "context" : "unchanged");
      append(chars.slice(start, chars.length - end).join(""), kind);
      append(end ? chars.slice(-end).join("") : "", context ? "context" : "unchanged");
    };
    name(oldChars, "removed");
    append(" → ", "context");
    name(newChars, "added");
  };
  changed(previous.name, next.name);
  if (
    (directory || previous.directory !== next.directory) &&
    (previous.directory || next.directory)
  ) {
    append("  ", "context");
    changed(previous.directory || ".", next.directory || ".", true);
  }
  return parts;
}

/** Expanded subtree order: folders first, then alphabetical names. */
export function compareReviewFilePaths(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] === b[index]) continue;
    return (
      Number(index < b.length - 1) - Number(index < a.length - 1) ||
      a[index]!.localeCompare(b[index]!)
    );
  }
  return a.length - b.length;
}
export function orderReviewFiles<T>(
  files: ReadonlyArray<T>,
  pathOf: (file: T) => string,
  grouped = false,
): T[] {
  const rank = { implementation: 0, tests: 1, generated: 2 };
  return [...files].sort(
    (a, b) =>
      (grouped ? rank[reviewFileGroup(pathOf(a))] - rank[reviewFileGroup(pathOf(b))] : 0) ||
      compareReviewFilePaths(pathOf(a), pathOf(b)),
  );
}
export function reviewFolderContains(folder: string, path: string): boolean {
  return path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

/** Native file sheets retain the same folder-first order as the desktop diff. */
export function reviewFileTreeRows<T>(
  files: ReadonlyArray<T>,
  pathOf: (file: T) => string,
  collapsed: ReadonlySet<string>,
) {
  interface Folder {
    path: string;
    folders: Map<string, Folder>;
    files: Array<{ path: string; file: T }>;
  }
  const root: Folder = { path: "", folders: new Map(), files: [] };
  for (const file of orderReviewFiles(files, pathOf)) {
    const path = pathOf(file);
    const parts = path.split("/");
    let folder = root;
    for (const name of parts.slice(0, -1)) {
      let child = folder.folders.get(name);
      if (!child) {
        child = {
          path: folder.path ? `${folder.path}/${name}` : name,
          folders: new Map(),
          files: [],
        };
        folder.folders.set(name, child);
      }
      folder = child;
    }
    folder.files.push({ path, file });
  }
  const rows: Array<
    | { kind: "folder"; path: string; label: string; depth: number }
    | { kind: "file"; path: string; depth: number; file: T }
  > = [];
  const append = (parent: Folder, depth: number) => {
    for (const initial of parent.folders.values()) {
      let folder = initial;
      // Single-child chains carry no branching information. Keep their full path for actions,
      // while giving the next real subtree just one indentation level on a narrow screen.
      while (
        !collapsed.has(folder.path) &&
        folder.files.length === 0 &&
        folder.folders.size === 1
      ) {
        folder = folder.folders.values().next().value!;
      }
      rows.push({
        kind: "folder",
        path: folder.path,
        label: folder.path.slice(parent.path ? parent.path.length + 1 : 0),
        depth,
      });
      if (!collapsed.has(folder.path)) append(folder, depth + 1);
    }
    for (const { path, file } of parent.files) rows.push({ kind: "file", path, depth, file });
  };
  append(root, 0);
  return rows;
}

export interface ReviewFileFilter {
  readonly commentsOnly?: boolean;
  readonly hideReviewed?: boolean;
}
export function isReviewFileVisible(
  filter: ReviewFileFilter,
  viewed: boolean,
  hasUnresolvedComments: boolean,
): boolean {
  return (!filter.commentsOnly || hasUnresolvedComments) && (!filter.hideReviewed || !viewed);
}
/**
 * Count unresolved conversations and private draft comments under the file's current name.
 * A supplied draft list is the client's merged, authoritative list, including removals that
 * the last host snapshot does not reflect yet. Hosted drafts must not count twice.
 */
export function reviewCommentCounts(
  files: ReadonlyArray<{ path: string; previousPath?: string | null | undefined }>,
  threads: ReadonlyArray<{
    path: string;
    isResolved: boolean;
    comments?: ReadonlyArray<{ id: string; pendingReviewId?: string | undefined }>;
  }>,
  pendingComments?: ReadonlyArray<{
    path: string;
    id?: string | undefined;
    hostedComment?: { commentId: string } | undefined;
  }>,
) {
  const paths = new Map(
    files.flatMap(
      (file) =>
        [
          [file.path, file.path],
          ...(file.previousPath ? [[file.previousPath, file.path]] : []),
        ] as [string, string][],
    ),
  );
  const counts = new Map<string, { total: number; unresolved: number }>();
  const publishedIds = new Set<string>();
  const hostedDrafts: { path: string; id?: string; hostedComment: { commentId: string } }[] = [];
  const add = (originalPath: string, unresolved: boolean) => {
    const path = paths.get(originalPath) ?? originalPath;
    const count = counts.get(path) ?? { total: 0, unresolved: 0 };
    counts.set(path, { total: count.total + 1, unresolved: count.unresolved + Number(unresolved) });
  };
  for (const thread of threads) {
    for (const comment of thread.comments ?? []) {
      if (comment.pendingReviewId) {
        hostedDrafts.push({ path: thread.path, hostedComment: { commentId: comment.id } });
      } else publishedIds.add(comment.id);
    }
    if (!thread.comments?.length || thread.comments.some((comment) => !comment.pendingReviewId))
      add(thread.path, !thread.isResolved);
  }
  const seen = new Set<string>();
  for (const draft of pendingComments ?? hostedDrafts) {
    const hostedId = draft.hostedComment?.commentId;
    if (hostedId && publishedIds.has(hostedId)) continue;
    const key = hostedId ? `host:${hostedId}` : draft.id ? `local:${draft.id}` : undefined;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    add(draft.path, true);
  }
  return counts;
}
/** Toggle endpoints while filling every commit between them. Removing an interior commit keeps the nearer edge. */
export function toggleReviewCommit(
  commits: ReadonlyArray<string>,
  selected: ReadonlyArray<string>,
  oid: string,
): string[] {
  const at = commits.indexOf(oid);
  if (at < 0) return [...selected];
  const indices = selected.map((value) => commits.indexOf(value)).filter((index) => index >= 0);
  if (indices.length === 0) return [oid];
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  if (at < first || at > last) return commits.slice(Math.min(first, at), Math.max(last, at) + 1);
  if (first === last) return [];
  if (at === first) return commits.slice(first + 1, last + 1);
  if (at === last) return commits.slice(first, last);
  return at - first < last - at ? commits.slice(at + 1, last + 1) : commits.slice(first, at);
}
export { reviewSelectedLinesPatch } from "./reviewLineStaging.ts";

/** Raw git patch hunks with their file headers, usable by both surfaces for partial staging. */
export function reviewPatchHunks(
  patch: string,
): ReadonlyArray<{ readonly filePatch: string; readonly hunks: ReadonlyArray<string> }> {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((filePatch) => {
      const parts = filePatch.split(/(?=^@@ )/m);
      const header = (parts.shift() ?? "").replace(/^index .*\n/gm, "");
      return { filePatch, hunks: parts.map((hunk) => header + hunk) };
    });
}

/** Match a visible hunk by its range, so context expansion cannot stage a neighboring hunk. */
export function reviewHunkPatch(hunks: ReadonlyArray<string>, header: string): string | undefined {
  const rangeKey = (text: string) => {
    const range = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m);
    return range ? `${range[1]},${range[2] ?? "1"}:${range[3]},${range[4] ?? "1"}` : null;
  };
  const range = rangeKey(header);
  const exact = range ? hunks.find((patch) => rangeKey(patch) === range) : undefined;
  if (exact) return exact;
  const visible = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m);
  if (!visible) return undefined;
  const within = (line: number, side: "old" | "new") => {
    const start = Number(visible[side === "old" ? 1 : 3]);
    const count = Number(visible[side === "old" ? 2 : 4] ?? 1);
    return line >= start && line < start + count;
  };
  // Retained reader windows contain context; the optimistic Git patches use zero context.
  // Include only hunks whose actual edits fit this window, never an adjacent context overlap.
  const matched = hunks.filter((patch) => {
    const raw = patch.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m);
    if (!raw) return false;
    let oldLine = Number(raw[1]);
    let newLine = Number(raw[3]);
    let changed = false;
    for (const line of patch
      .slice(raw.index! + raw[0].length)
      .split("\n")
      .slice(1)) {
      const sign = line[0];
      if (sign === "-" || sign === "+") {
        changed = true;
        if (!within(sign === "-" ? oldLine : newLine, sign === "-" ? "old" : "new")) return false;
      }
      if (sign === " " || sign === "-") oldLine++;
      if (sign === " " || sign === "+") newLine++;
    }
    return changed;
  });
  if (!matched.length) return undefined;
  const prefix = matched[0]!.slice(0, matched[0]!.indexOf("@@ "));
  return prefix + matched.map((patch) => patch.slice(patch.indexOf("@@ "))).join("");
}

/** The current account's latest completed review, including reviews containing only line comments. */
export function latestReviewedCommit(
  comments: ReadonlyArray<{
    kind: string;
    author: { login: string } | null;
    createdAt: string;
    reviewCommitSha?: string | undefined;
    reviewState?: string | null | undefined;
  }>,
  viewer: string | null | undefined,
): string | null {
  if (!viewer) return null;
  return (
    comments
      .filter(
        (comment) =>
          comment.kind === "review" &&
          comment.reviewState?.toUpperCase() !== "PENDING" &&
          comment.author?.login.toLowerCase() === viewer.toLowerCase() &&
          comment.reviewCommitSha,
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]?.reviewCommitSha ?? null
  );
}
export function reviewCommitSelection(
  commits: ReadonlyArray<string>,
  scope: string | null,
): string[] {
  if (scope === null) return [...commits];
  const [first, last] = scope.split("..");
  if (!last) return commits.includes(scope) ? [scope] : [];
  const start = commits.indexOf(first ?? "");
  const end = commits.indexOf(last);
  return start >= 0 && end >= start ? commits.slice(start, end + 1) : [];
}
export function reviewCommitScope(selection: ReadonlyArray<string>): string | null {
  return selection.length === 0
    ? null
    : selection.length === 1
      ? selection[0]!
      : `${selection[0]}..${selection.at(-1)}`;
}

/**
 * Unified-diff anchor index for pull request review comments.
 *
 * GitHub rejects an entire review submission (HTTP 422) when *any* inline
 * comment points at a line that is not part of the diff. Review models
 * routinely emit whole-file line numbers, so posting their raw output loses
 * the review — not just the offending comment. Indexing the diff up front
 * lets the caller keep anchorable comments inline and demote the rest into
 * the review body.
 *
 * Parsing errs toward dropping anchors: an unrecognised construct ends the
 * current hunk instead of guessing line numbers. Over-filtering only moves a
 * comment into the body, while under-filtering fails the whole review.
 */

export interface DiffFileAnchors {
  /** Pre-change path; null when the file was added. */
  readonly oldPath: string | null;
  /** Post-change path; null when the file was deleted. */
  readonly newPath: string | null;
  /** Line numbers addressable with `side: "RIGHT"` (added + context lines). */
  readonly right: ReadonlySet<number>;
  /** Line numbers addressable with `side: "LEFT"` (removed + context lines). */
  readonly left: ReadonlySet<number>;
}

export type DiffAnchors = ReadonlyMap<string, DiffFileAnchors>;

export type DiffAnchorSide = "LEFT" | "RIGHT";

export interface DiffAnchor {
  readonly side: DiffAnchorSide;
  /**
   * Path GitHub expects for this side. Renames are reachable under both
   * names, but the API only accepts the new path on RIGHT and the old path on
   * LEFT — posting the model's spelling would 422 the batch.
   */
  readonly path: string;
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Strip the `a/` / `b/` prefix git puts on diff paths, unwrap the C-style
 * quoting git applies to paths with spaces or non-ASCII bytes, and reject the
 * `/dev/null` placeholder used for added and deleted files.
 */
function normalizeDiffPath(raw: string): string | null {
  let value = raw.trim();
  // `--- a/file.ts\t2024-01-01` — timestamps only appear on non-git diffs.
  const tab = value.indexOf("\t");
  if (tab >= 0) {
    value = value.slice(0, tab);
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  if (!value || value === "/dev/null") {
    return null;
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    value = value.slice(2);
  }
  return normalizeCommentPath(value);
}

/** Repo-relative form used as the anchor map key and for comment lookups. */
export function normalizeCommentPath(path: string): string {
  let value = path.trim().replaceAll("\\", "/");
  while (value.startsWith("./")) {
    value = value.slice(2);
  }
  while (value.startsWith("/")) {
    value = value.slice(1);
  }
  return value;
}

interface MutableAnchors {
  oldPath: string | null;
  newPath: string | null;
  readonly right: Set<number>;
  readonly left: Set<number>;
}

export function parseDiffAnchors(patch: string): DiffAnchors {
  const files = new Map<string, MutableAnchors>();
  const entryFor = (path: string): MutableAnchors => {
    const existing = files.get(path);
    if (existing) {
      return existing;
    }
    const created: MutableAnchors = {
      oldPath: null,
      newPath: null,
      right: new Set(),
      left: new Set(),
    };
    files.set(path, created);
    return created;
  };

  let current: MutableAnchors | null = null;
  let oldPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = normalizeDiffPath(line.slice(4));
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = normalizeDiffPath(line.slice(4));
      const key = newPath ?? oldPath;
      current = key === null ? null : entryFor(key);
      if (current !== null) {
        current.oldPath = oldPath;
        current.newPath = newPath;
        // Renames: comments may reference either name, so both keys share one
        // anchor set. `resolveCommentAnchor` rewrites the path back to the
        // side-correct one when it reports the match.
        if (newPath !== null && oldPath !== null && newPath !== oldPath) {
          files.set(oldPath, current);
        }
      }
      inHunk = false;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = current !== null && Number.isSafeInteger(oldLine) && Number.isSafeInteger(newLine);
      continue;
    }

    if (!inHunk || current === null) {
      continue;
    }

    const marker = line.charAt(0);
    if (marker === "+") {
      current.right.add(newLine);
      newLine += 1;
      continue;
    }
    if (marker === "-") {
      current.left.add(oldLine);
      oldLine += 1;
      continue;
    }
    if (marker === " ") {
      current.right.add(newLine);
      current.left.add(oldLine);
      newLine += 1;
      oldLine += 1;
      continue;
    }
    // "\ No newline at end of file" annotates the previous line.
    if (marker === "\\") {
      continue;
    }
    // Anything else (blank separator, `Binary files ... differ`, a truncated
    // tail) is not a hunk body line — stop trusting the running counters.
    inHunk = false;
  }

  return files;
}

/**
 * Resolve the side and path a comment can actually be anchored on, or null
 * when the referenced line is absent from the diff. A comment without an
 * explicit side prefers RIGHT (the post-change file), matching how review
 * models describe findings.
 */
export function resolveCommentAnchor(input: {
  readonly anchors: DiffAnchors;
  readonly path: string;
  readonly line: number | null;
  readonly side: DiffAnchorSide | null;
}): DiffAnchor | null {
  if (input.line === null || !Number.isSafeInteger(input.line) || input.line <= 0) {
    return null;
  }
  const normalizedPath = normalizeCommentPath(input.path);
  const entry = input.anchors.get(normalizedPath);
  if (!entry) {
    return null;
  }
  const anchorFor = (side: DiffAnchorSide): DiffAnchor => ({
    side,
    // Fall back to the other name (and finally to the caller's spelling) for
    // adds and deletes, where one side of the rename pair does not exist.
    path:
      (side === "LEFT" ? (entry.oldPath ?? entry.newPath) : (entry.newPath ?? entry.oldPath)) ??
      normalizedPath,
  });
  if (input.side === "LEFT") {
    return entry.left.has(input.line) ? anchorFor("LEFT") : null;
  }
  if (input.side === "RIGHT") {
    return entry.right.has(input.line) ? anchorFor("RIGHT") : null;
  }
  if (entry.right.has(input.line)) {
    return anchorFor("RIGHT");
  }
  return entry.left.has(input.line) ? anchorFor("LEFT") : null;
}

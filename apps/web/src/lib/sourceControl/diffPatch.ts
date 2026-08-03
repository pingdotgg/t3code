// ─── Hunk parsing + single-hunk patch synthesis ─────────────────────────────
//
// Per-hunk stage / unstage / discard needs a *minimal but valid* unified diff
// carrying exactly one hunk, fed to `git apply --whitespace=nowarn --recount`
// (optionally `--cached` / `--reverse`).
//
// Hunks are parsed straight from the RAW unified diff, never from a rendered
// line model: a renderer drops the per-line ` `/`+`/`-` prefix and the
// `\ No newline at end of file` markers, which makes round-tripping a
// byte-exact patch fragile. Keeping the raw body lines means they can be
// re-emitted verbatim and only the `@@` header is recomputed.

export interface DiffHunk {
  /** The original `@@ -a,b +c,d @@ …` header line, verbatim. */
  readonly header: string;
  /** 1-based start line on the OLD side (from the header). */
  readonly oldStart: number;
  /** 1-based start line on the NEW side (from the header). */
  readonly newStart: number;
  /** Body lines, each still carrying its leading ` ` | `+` | `-` | `\` char. */
  readonly body: ReadonlyArray<string>;
  /** Added / removed counts (context excluded), for the hunk label. */
  readonly additions: number;
  readonly deletions: number;
}

export interface ParsedFileDiff {
  /** The `a/…` path from the `diff --git` / `---` header (without the `a/`). */
  readonly oldPath: string;
  /** The `b/…` path from the `diff --git` / `+++` header (without the `b/`). */
  readonly newPath: string;
  readonly hunks: ReadonlyArray<DiffHunk>;
}

interface MutableDiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  body: string[];
  additions: number;
  deletions: number;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_DIFF_HEADER_PATTERN = /^diff --git a\/(.+) b\/(.+)$/;

/** Body-line shapes inside a hunk: context, addition, deletion, no-newline marker. */
function isBodyShaped(line: string): boolean {
  const first = line[0];
  return first === " " || first === "+" || first === "-" || first === "\\" || line === "";
}

function stripPathPrefix(pathValue: string): string {
  // `--- a/foo` / `+++ b/foo`; also tolerate `--- foo` with no prefix.
  return pathValue.startsWith("a/") || pathValue.startsWith("b/") ? pathValue.slice(2) : pathValue;
}

/**
 * Parse a raw unified diff for a SINGLE file into its paths plus hunks.
 * Returns `null` when the diff carries no textual hunk (binary, pure rename,
 * mode-only change, empty input).
 */
export function parseFileDiff(raw: string): ParsedFileDiff | null {
  if (!raw) {
    return null;
  }

  const lines = raw.split("\n");
  const hunks: MutableDiffHunk[] = [];
  let oldPath = "";
  let newPath = "";
  let current: MutableDiffHunk | null = null;
  // Remaining old/new line budget declared by the current hunk's `@@` header.
  // While the budget holds, a body-shaped line is BODY — even when it looks
  // like a file header. Deleting a line whose text happens to start with
  // `--- ` or `+++ ` emits exactly that inside the hunk, and reading it as a
  // header would silently drop the line from the patch handed to `git apply`.
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of lines) {
    // A `\ No newline at end of file` marker trails the line it annotates and
    // spans nothing, so it can legitimately arrive after the budget is spent.
    if (current && (oldRemaining > 0 || newRemaining > 0 || line.startsWith("\\"))) {
      if (isBodyShaped(line)) {
        const first = line[0];
        if (first === "+") {
          current.body.push(line);
          current.additions += 1;
          newRemaining -= 1;
        } else if (first === "-") {
          current.body.push(line);
          current.deletions += 1;
          oldRemaining -= 1;
        } else if (first === "\\") {
          // Spans no line on either side.
          current.body.push(line);
        } else if (line === "") {
          // Some emitters drop the leading space on an empty context line.
          current.body.push(" ");
          oldRemaining -= 1;
          newRemaining -= 1;
        } else {
          current.body.push(line);
          oldRemaining -= 1;
          newRemaining -= 1;
        }
        continue;
      }
      // Not body-shaped: the hunk is truncated or malformed. Abandon it and let
      // the line be re-read as a header below.
      current = null;
      oldRemaining = 0;
      newRemaining = 0;
    }

    if (line.startsWith("diff --git ")) {
      const [, matchedOldPath, matchedNewPath] = line.match(GIT_DIFF_HEADER_PATTERN) ?? [];
      if (matchedOldPath !== undefined && matchedNewPath !== undefined) {
        oldPath = oldPath || matchedOldPath;
        newPath = newPath || matchedNewPath;
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      const candidate = line.slice(4);
      if (candidate !== "/dev/null") {
        oldPath = stripPathPrefix(candidate);
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const candidate = line.slice(4);
      if (candidate !== "/dev/null") {
        newPath = stripPathPrefix(candidate);
      }
      continue;
    }

    if (line.startsWith("@@")) {
      const match = line.match(HUNK_HEADER_PATTERN);
      const [, oldStartRaw, oldCountRaw, newStartRaw, newCountRaw] = match ?? [];
      if (oldStartRaw === undefined || newStartRaw === undefined) {
        continue;
      }
      const hunk: MutableDiffHunk = {
        header: line,
        oldStart: Number.parseInt(oldStartRaw, 10),
        newStart: Number.parseInt(newStartRaw, 10),
        body: [],
        additions: 0,
        deletions: 0,
      };
      hunks.push(hunk);
      current = hunk;
      // An omitted count means 1 (`@@ -3 +3 @@`), not 0.
      oldRemaining = oldCountRaw === undefined ? 1 : Number.parseInt(oldCountRaw, 10);
      newRemaining = newCountRaw === undefined ? 1 : Number.parseInt(newCountRaw, 10);
      if (oldRemaining <= 0 && newRemaining <= 0) {
        // Degenerate empty hunk.
        current = null;
      }
      continue;
    }

    // Anything else outside a hunk (index/mode/similarity headers, trailing
    // junk) carries no content worth keeping.
  }

  return hunks.length > 0 ? { oldPath, newPath, hunks } : null;
}

/**
 * Old/new line spans derived from the BODY, so a re-emitted `@@` header is
 * internally consistent even when the source header omitted or over-declared
 * its counts.
 */
function hunkSpans(hunk: DiffHunk): { oldCount: number; newCount: number } {
  let oldCount = 0;
  let newCount = 0;
  for (const line of hunk.body) {
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" spans nothing.
      continue;
    }
    const first = line[0];
    if (first === "+") {
      newCount += 1;
    } else if (first === "-") {
      oldCount += 1;
    } else {
      oldCount += 1;
      newCount += 1;
    }
  }
  return { oldCount, newCount };
}

/**
 * Build a minimal, `git apply`-valid patch containing exactly one hunk.
 *
 * `filePath` is the working-tree path of the file, and it is used on BOTH the
 * `a/` and `b/` sides. For a rename that is deliberate: a hunk patch only ever
 * touches content, and `git apply --cached` resolves against the index by the
 * `b/` side, so a content hunk for a renamed file must address the new name.
 *
 * The result always ends in a newline — `git apply` requires it.
 */
export function buildHunkPatch(filePath: string, hunk: DiffHunk): string {
  const { oldCount, newCount } = hunkSpans(hunk);
  const oldStart = oldCount === 0 ? 0 : hunk.oldStart;
  const newStart = newCount === 0 ? 0 : hunk.newStart;
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...hunk.body,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * fork: f4 — true when the diff's OLD side is `/dev/null`, i.e. the file does
 * not exist on that side at all. For an untracked file the server synthesizes
 * the patch with `diff --no-index /dev/null <path>`, and `buildHunkPatch`
 * rebuilds the header as `--- a/<path>` (it has to, for every other case), so a
 * one-hunk patch cut from it would be handed to `git apply --cached` for a path
 * that is not in the index — which always fails.
 */
export function isNewFileDiff(raw: string): boolean {
  return /^--- \/dev\/null$/m.test(raw);
}

/** True when the raw diff has at least one textual hunk that can be staged. */
export function hasStageableHunks(raw: string): boolean {
  const parsed = parseFileDiff(raw);
  return parsed !== null && parsed.hunks.length > 0;
}

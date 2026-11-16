import { md5, sha1 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export interface PullRequestAnchorRange {
  readonly start: number;
  readonly side: "left" | "right";
  readonly end: number;
  readonly endSide: "left" | "right";
  /** A GitLab line code's old-side counter: the line it names when that old line was removed. */
  readonly oldLine?: number;
}

export type PullRequestAnchor =
  | { readonly kind: "code" }
  | { readonly kind: "commits" }
  | { readonly kind: "checks" }
  | {
      readonly kind: "diff";
      readonly digest: string;
      readonly range: PullRequestAnchorRange | null;
    }
  | { readonly kind: "timeline"; readonly anchor: string }
  | { readonly kind: "summary"; readonly anchor: string };

function pullRequestUrlHash(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return decodeURIComponent(new URL(url).hash.slice(1));
  } catch {
    return "";
  }
}

function normalizePullRequestCommentAnchor(anchor: string): string {
  return anchor.replace(
    /^(?:r|discussion-diff-)(\d+)(?:[LR]\d+(?:-[LR]\d+)?)?$/i,
    "discussion_r$1",
  );
}

// GitHub pull request tabs and their GitLab merge request equivalents.
function pullRequestPathTab(pathname: string): PullRequestAnchor | null {
  const tab = /\/(?:pull|-\/merge_requests)\/\d+\/([a-z]+)(?:\/(.*))?$/i.exec(pathname);
  const rest = tab?.[2] ?? "";
  switch (tab?.[1]?.toLowerCase()) {
    case "files":
    case "changes":
    case "diffs":
      return { kind: "code" };
    case "commits":
      if (rest === "") return { kind: "commits" };
      return /^[a-f0-9]{40}\/?$/i.test(rest) ? { kind: "code" } : null;
    case "checks":
    case "pipelines":
      return rest === "" ? { kind: "checks" } : null;
    default:
      return null;
  }
}

const isLine = (line: number) => Number.isSafeInteger(line) && line >= 1;

function gitLabLine(
  start: number,
  side: "left" | "right",
  oldLine = 0,
): PullRequestAnchorRange | null {
  if (!isLine(start)) return null;
  return { start, side, end: start, endSide: side, ...(isLine(oldLine) ? { oldLine } : {}) };
}

// GitLab names a file by its path's SHA-1 and a line by `<sha1>_<old>_<new>`, which carries both
// sides' counters. Rapid Diffs writes `line_<sha1 prefix>_<old>` or `_A<new>`.
function gitLabDiffAnchor(anchor: string, file: string | null): PullRequestAnchor | null {
  const rapid = /^line_([a-f0-9]{9})_(A?)(\d+)$/i.exec(anchor);
  if (rapid) {
    const line = Number(rapid[3]);
    return {
      kind: "diff",
      digest: (rapid[1] ?? "").toLowerCase(),
      range: gitLabLine(line, rapid[2] ? "right" : "left"),
    };
  }
  const code = /^(?:diff-content-)?([a-f0-9]{40})(?:_(\d+)_(\d+))?$/i.exec(anchor);
  // A comment anchor beside `?file=` names the comment.
  const digest =
    code?.[1] ?? (!anchor && file !== null && /^[a-f0-9]{40}$/i.test(file) ? file : null);
  if (digest === null) return null;
  const [oldLine, newLine] = [Number(code?.[2]), Number(code?.[3])];
  // A deleted file has no new side, so its new counter is 0.
  const range =
    code?.[2] === undefined
      ? null
      : newLine === 0
        ? gitLabLine(oldLine, "left")
        : gitLabLine(newLine, "right", oldLine);
  return { kind: "diff", digest: digest.toLowerCase(), range };
}

/** The range to select, once the diff shows whether a GitLab line code's old line was removed. */
export function resolvePullRequestAnchorRange(
  range: PullRequestAnchorRange,
  isRemovedLine: (oldLine: number) => boolean,
): PullRequestAnchorRange {
  return range.oldLine !== undefined && isRemovedLine(range.oldLine)
    ? (gitLabLine(range.oldLine, "left") ?? range)
    : range;
}

export function parsePullRequestAnchor(url: string | null | undefined): PullRequestAnchor | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return null;
  }
  const fallback = pullRequestPathTab(parsed.pathname);
  const anchor = pullRequestUrlHash(url);
  const gitLab = gitLabDiffAnchor(
    anchor,
    /\/-\/merge_requests\/\d+\/diffs\/?$/i.test(parsed.pathname)
      ? parsed.searchParams.get("file")
      : null,
  );
  if (gitLab) return gitLab;
  if (!anchor) return fallback;
  // GitHub line ranges may cross diff sides; file digests were MD5 before SHA-256.
  const diff = /^diff-([a-f0-9]+)(?:([LR])(\d+)(?:-([LR])(\d+))?)?$/i.exec(anchor);
  if (diff) {
    const start = Number(diff[3]);
    const end = Number(diff[5] ?? diff[3]);
    if (
      diff[2] &&
      (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < 1)
    )
      return fallback;
    return {
      kind: "diff",
      digest: (diff[1] ?? "").toLowerCase(),
      range: diff[2]
        ? {
            start,
            side: diff[2].toUpperCase() === "L" ? "left" : "right",
            end,
            endSide: (diff[4] ?? diff[2]).toUpperCase() === "L" ? "left" : "right",
          }
        : null,
    };
  }
  if (
    /^(?:(?:issuecomment-|pullrequestreview-|discussion_r|r|commitcomment-|event-|note_|comment-)\d+|discussion-diff-\d+(?:[LR]\d+(?:-[LR]\d+)?)?)$/i.test(
      anchor,
    )
  ) {
    return { kind: "timeline", anchor: normalizePullRequestCommentAnchor(anchor) };
  }
  return fallback ?? { kind: "summary", anchor };
}

export function pullRequestAnchorMatchesUrl(
  anchor: string,
  url: string | null | undefined,
): boolean {
  return normalizePullRequestCommentAnchor(pullRequestUrlHash(url)) === anchor;
}

interface AnchoredComment {
  readonly url: string | null;
  readonly createdAt: string;
  readonly reviewUrl?: string | null | undefined;
}

/**
 * A review with no text of its own appears only through the line comments it posted, so its link
 * resolves to the earliest of those. Any other anchor, or a review shown in its own right, is kept.
 */
export function resolvePullRequestReviewAnchor(
  anchor: string,
  comments: ReadonlyArray<Pick<AnchoredComment, "url">>,
  reviewThreads: ReadonlyArray<{ readonly comments: ReadonlyArray<AnchoredComment> }>,
): string {
  if (!/^pullrequestreview-\d+$/i.test(anchor)) return anchor;
  if (comments.some((comment) => pullRequestAnchorMatchesUrl(anchor, comment.url))) return anchor;
  // The earliest comment the review posted; `toSorted` is missing from Hermes.
  let posted: AnchoredComment | undefined;
  for (const comment of reviewThreads.flatMap((thread) => thread.comments)) {
    if (comment.url === null || !pullRequestAnchorMatchesUrl(anchor, comment.reviewUrl)) continue;
    if (posted === undefined || comment.createdAt < posted.createdAt) posted = comment;
  }
  const own = posted ? normalizePullRequestCommentAnchor(pullRequestUrlHash(posted.url)) : "";
  return own || anchor;
}

export function pullRequestDiffPathMatches(digest: string, path: string): boolean {
  const bytes = utf8ToBytes(path);
  // GitLab uses SHA-1, abbreviated to 9 characters in Rapid Diffs line anchors.
  if (digest.length === 40 || digest.length === 9)
    return bytesToHex(sha1(bytes)).startsWith(digest);
  return digest === bytesToHex(digest.length === 32 ? md5(bytes) : sha256(bytes));
}

export function pullRequestLinkCommit(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { pathname, searchParams } = new URL(url);
    const commit = /\/-\/merge_requests\/\d+\/diffs\/?$/i.test(pathname)
      ? searchParams.get("commit_id")
      : /\/pull\/\d+\/commits\/([a-f0-9]{40})\/?$/i.exec(pathname)?.[1];
    return commit && /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

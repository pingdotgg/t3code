import { md5, sha1 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export interface PullRequestAnchorRange {
  readonly start: number;
  readonly side: "left" | "right";
  readonly end: number;
  readonly endSide: "left" | "right";
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

export function parsePullRequestAnchor(url: string | null | undefined): PullRequestAnchor | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return null;
  }
  const fallback = pullRequestPathTab(parsed.pathname);
  const anchor = pullRequestUrlHash(url);
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
  // GitLab: SHA-1 of the path, then old and new line counters. A removed line still carries a
  // new counter, so the new side wins unless the file has none (a 0 for a deleted file).
  const gitlab = /^([a-f0-9]{40})(?:_(\d+)_(\d+))?$/i.exec(anchor);
  if (gitlab) {
    const digest = (gitlab[1] ?? "").toLowerCase();
    if (!gitlab[2]) return { kind: "diff", digest, range: null };
    const newLine = Number(gitlab[3]);
    const oldLine = Number(gitlab[2]);
    const side = newLine >= 1 ? "right" : "left";
    const line = side === "right" ? newLine : oldLine;
    if (!Number.isSafeInteger(line) || line < 1) return fallback;
    return { kind: "diff", digest, range: { start: line, side, end: line, endSide: side } };
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
  const hash = digest.length === 32 ? md5 : digest.length === 40 ? sha1 : sha256;
  return digest === bytesToHex(hash(bytes));
}

export function pullRequestLinkCommit(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return /\/pull\/\d+\/commits\/([a-f0-9]{40})\/?$/i.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

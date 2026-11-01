/**
 * The pull-request view (`/:owner/:repo/pulls/:number`): GitHub-style
 * title/state header, branch line, Markdown body, mergeability box with
 * Merge/Close/Reopen actions, and tabbed Commits + Files changed from
 * the three-dot `/compare` endpoint.
 *
 * `React.lazy`-loaded from `Repo.tsx` — the Files-changed tab renders
 * through the shared `FileDiffList` (diffs+shiki runtime), which must
 * stay out of the initial bundle.
 */
import { useEffect, useState } from "react";
import {
  ApiError,
  compareCommits,
  getPull,
  mergePull,
  updatePull,
  type Comparison,
  type PullDetail,
} from "../client.ts";
import {
  Button,
  CopyButton,
  ErrorBox,
  Markdown,
  Spinner,
} from "../components.tsx";
import { shortOid, subject, timeAgo } from "../format.ts";
import { href, Link } from "../router.tsx";
import FileDiffList from "./DiffList.tsx";
import { PullStateBadge, shortRef } from "./Pulls.tsx";
import type { RepoContext } from "./Repo.tsx";

// ── typed-error presentation ────────────────────────────────────────────────

/** Maps the service's typed merge/update errors to inline messages. */
const friendlyError = (cause: unknown): string => {
  if (!(cause instanceof ApiError)) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  switch (cause.tag) {
    case "MergeConflict":
      return "Merge conflict — files were changed on both branches relative to the merge base. Resolve the conflict locally and push, or close this pull request.";
    case "BranchMissing":
      return "The base or head branch no longer exists.";
    case "NothingToMerge":
      return "Nothing to merge — the head branch is already part of the base branch.";
    case "RefConflict":
      return "A branch moved while merging (force-push or concurrent update) — review the new tip and try again.";
    case "PullStateConflict":
      return "The pull request's state changed underneath this page — it has been refreshed.";
    case "ReadOnlyRepo":
      return "This repository is read-only — merging is disabled.";
    case "Forbidden":
      return "Your token does not have write access to this repository.";
    default:
      return `${cause.tag}: ${cause.message}`;
  }
};

// ── mergeability box ────────────────────────────────────────────────────────

const mergeStatus = (
  detail: PullDetail,
): { tone: "success" | "danger" | "muted"; text: string } => {
  if (detail.mergeable === true) {
    return {
      tone: "success",
      text:
        detail.mergeableReason === "ff"
          ? "This branch has no conflicts with the base branch — it can be fast-forwarded."
          : "This branch has no conflicts with the base branch — a merge commit will be created.",
    };
  }
  if (detail.mergeable === false) {
    return detail.mergeableReason === "up-to-date"
      ? {
          tone: "muted",
          text: "Nothing to merge — the head branch is already part of the base branch.",
        }
      : {
          tone: "danger",
          text: "This branch has conflicts with the base branch — the same files were changed on both sides.",
        };
  }
  return {
    tone: "muted",
    text:
      detail.baseOid === null || detail.headOid === null
        ? "Mergeability unknown — the base or head branch no longer exists."
        : "Mergeability could not be computed for this pull request.",
  };
};

// ── the page ────────────────────────────────────────────────────────────────

type CompareState = Comparison | "unavailable" | null; // null = loading

const PullPage = ({
  context,
  number,
}: {
  context: RepoContext;
  number: number;
}) => {
  const [detail, setDetail] = useState<PullDetail | null>(null);
  const [compare, setCompare] = useState<CompareState>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<"files" | "commits">("files");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const { connection, repo } = context;
  const signedIn = context.user !== null;

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setCompare(null);
    setError(null);
    void (async () => {
      try {
        const pull = await getPull(connection, repo.owner, repo.name, number);
        if (cancelled) return;
        setDetail(pull);
        // Live compare only when both branches still exist (merged PRs
        // return null tips — their record is the merge commit).
        if (pull.baseOid !== null && pull.headOid !== null) {
          const comparison = await compareCommits(
            connection,
            repo.owner,
            repo.name,
            { base: pull.baseRef, head: pull.headRef },
          );
          if (!cancelled) setCompare(comparison);
        } else {
          setCompare("unavailable");
        }
      } catch (cause) {
        if (!cancelled) setError(cause);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number, repo.repoId, generation]);

  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    void run()
      .then(() => setGeneration((value) => value + 1))
      .catch((cause: unknown) => {
        setActionError(friendlyError(cause));
        // The state/tips this page shows are stale — reload them so the
        // message matches what the user now sees.
        if (
          cause instanceof ApiError &&
          (cause.tag === "PullStateConflict" || cause.tag === "RefConflict")
        ) {
          setGeneration((value) => value + 1);
        }
      })
      .finally(() => setBusy(false));
  };

  if (error != null) return <ErrorBox error={error} />;
  if (detail === null) return <Spinner />;

  const { owner, name } = repo;
  const status = mergeStatus(detail);
  const boxTone =
    status.tone === "success"
      ? "border-success/40 bg-success/5"
      : status.tone === "danger"
        ? "border-danger/40 bg-danger/5"
        : "border-border-muted bg-canvas-subtle";

  return (
    <div>
      {/* header */}
      <div className="mb-4 border-b border-border-muted pb-4">
        <h1 className="text-xl font-semibold">
          {detail.title}{" "}
          <span className="font-normal text-fg-muted">#{detail.number}</span>
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <PullStateBadge state={detail.state} />
          {detail.state === "merged" ? (
            <span>
              merged {timeAgo(detail.mergedAt ?? detail.updatedAt)}
              {detail.mergeCommit !== null && (
                <>
                  {" as "}
                  <Link
                    to={href(owner, name, "commit", detail.mergeCommit)}
                    className="font-mono text-accent hover:underline"
                  >
                    {shortOid(detail.mergeCommit)}
                  </Link>
                </>
              )}
              {" — "}
              <code className="font-mono">{shortRef(detail.headRef)}</code>
              {" into "}
              <code className="font-mono">{shortRef(detail.baseRef)}</code>
            </span>
          ) : (
            <span>
              wants to merge{" "}
              <code className="rounded bg-canvas-subtle px-1.5 py-0.5 font-mono">
                {shortRef(detail.headRef)}
              </code>{" "}
              into{" "}
              <code className="rounded bg-canvas-subtle px-1.5 py-0.5 font-mono">
                {shortRef(detail.baseRef)}
              </code>
              {" · opened "}
              {timeAgo(detail.createdAt)}
              {detail.aheadBy !== null && detail.behindBy !== null && (
                <>
                  {" · "}
                  {detail.aheadBy} commit{detail.aheadBy === 1 ? "" : "s"}{" "}
                  ahead, {detail.behindBy} behind
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {/* body */}
      {detail.body !== null && detail.body.trim().length > 0 && (
        <div className="mb-4 rounded-md border border-border-muted p-4">
          <Markdown source={detail.body} />
        </div>
      )}

      {/* mergeability + actions */}
      {detail.state === "open" && (
        <div className={`mb-4 rounded-md border px-4 py-3 text-sm ${boxTone}`}>
          <p
            className={
              status.tone === "success"
                ? "text-success"
                : status.tone === "danger"
                  ? "text-danger"
                  : "text-fg-muted"
            }
          >
            {status.text}
          </p>
          {signedIn && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                kind="primary"
                disabled={busy || detail.mergeable !== true}
                onClick={() =>
                  act(() =>
                    mergePull(connection, owner, name, number, {
                      // Race guard: fail 409 RefConflict if the head tip
                      // moved since this page loaded.
                      ...(detail.headOid !== null
                        ? { expectedHeadOid: detail.headOid }
                        : {}),
                    }),
                  )
                }
              >
                {busy ? "Working…" : "Merge pull request"}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  act(() =>
                    updatePull(connection, owner, name, number, {
                      state: "closed",
                    }),
                  )
                }
              >
                Close
              </Button>
              {detail.mergeable !== true && (
                <span className="text-xs text-fg-muted">
                  merging is disabled until the branch is mergeable
                </span>
              )}
            </div>
          )}
          {actionError !== null && (
            <p className="mt-2 text-sm text-danger">{actionError}</p>
          )}
        </div>
      )}
      {detail.state === "closed" && (
        <div className="mb-4 rounded-md border border-border-muted bg-canvas-subtle px-4 py-3 text-sm">
          <p className="text-fg-muted">
            This pull request is closed without being merged.
          </p>
          {signedIn && (
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={() =>
                  act(() =>
                    updatePull(connection, owner, name, number, {
                      state: "open",
                    }),
                  )
                }
              >
                Reopen
              </Button>
            </div>
          )}
          {actionError !== null && (
            <p className="mt-2 text-sm text-danger">{actionError}</p>
          )}
        </div>
      )}

      {/* compare: commits + files changed */}
      {compare === null ? (
        <Spinner />
      ) : compare === "unavailable" ? (
        <div className="rounded-md border border-border-muted px-4 py-8 text-center text-sm text-fg-muted">
          {detail.state === "merged" && detail.mergeCommit !== null ? (
            <>
              Live comparison is not available for merged pull requests — see
              the{" "}
              <Link
                to={href(owner, name, "commit", detail.mergeCommit)}
                className="font-mono text-accent hover:underline"
              >
                merge commit
              </Link>
              .
            </>
          ) : (
            "Comparison unavailable — the base or head branch no longer exists."
          )}
        </div>
      ) : (
        <>
          <div className="mb-4 flex gap-1 border-b border-border-muted text-sm">
            {(
              [
                ["files", `Files changed (${compare.files.length})`],
                ["commits", `Commits (${compare.commits.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`cursor-pointer border-b-2 px-3 py-2 ${
                  tab === key
                    ? "border-tab-active font-semibold"
                    : "border-transparent text-fg-muted hover:border-border-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "commits" ? (
            <ul className="overflow-hidden rounded-md border border-border-muted">
              {compare.commits.map((commit) => (
                <li
                  key={commit.oid}
                  className="flex items-start justify-between gap-4 border-b border-border-muted px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <Link
                      to={href(owner, name, "commit", commit.oid)}
                      className="text-sm font-semibold hover:text-accent hover:underline"
                    >
                      {subject(commit.message)}
                    </Link>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {commit.author.name} committed{" "}
                      {timeAgo(commit.author.date * 1000)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Link
                      to={href(owner, name, "commit", commit.oid)}
                      className="rounded border border-border-muted px-2 py-0.5 font-mono text-xs text-accent hover:underline"
                    >
                      {shortOid(commit.oid)}
                    </Link>
                    <CopyButton text={commit.oid} />
                  </div>
                </li>
              ))}
              {compare.commits.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-fg-muted">
                  No commits — the head branch is not ahead of the base.
                </li>
              )}
              {compare.commitsTruncated && (
                <li className="border-t border-border-muted bg-canvas-subtle px-4 py-2 text-center text-xs text-fg-muted">
                  Commit list truncated by the server.
                </li>
              )}
            </ul>
          ) : (
            <>
              {compare.filesTruncated && (
                <div className="mb-3 rounded-md border border-attention/40 bg-attention/5 px-4 py-2 text-sm text-attention">
                  This pull request changes more files than shown — the list was
                  truncated at {compare.files.length} files by the server.
                </div>
              )}
              <FileDiffList context={context} files={compare.files} />
            </>
          )}
        </>
      )}
    </div>
  );
};

export default PullPage;

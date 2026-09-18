/**
 * The commit view (`/:owner/:repo/commit/:oid`): GitHub-style page with
 * the commit message/metadata on top and one rendered diff per changed
 * file below.
 *
 * The server returns the changed-file *list* only (`commits/:oid/diff`);
 * the shared `FileDiffList` (see `DiffList.tsx`) fetches blob contents
 * and diffs locally with `@pierre/diffs`. This module is
 * `React.lazy`-loaded from `Repo.tsx` so the diffs+shiki runtime stays
 * out of the initial bundle.
 */
import { useEffect, useMemo, useState } from "react";
import {
  getCommit,
  getCommitDiff,
  type CommitDiff,
  type CommitInfo,
} from "../client.ts";
import { CopyButton, ErrorBox, Spinner } from "../components.tsx";
import { shortOid, subject, timeAgo } from "../format.ts";
import { href, Link } from "../router.tsx";
import FileDiffList from "./DiffList.tsx";
import type { RepoContext } from "./Repo.tsx";

const CommitPage = ({
  context,
  oid,
}: {
  context: RepoContext;
  /** Full 40-hex commit oid (links always carry the full oid). */
  oid: string;
}) => {
  const [data, setData] = useState<{
    commit: CommitInfo;
    diff: CommitDiff;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { connection, repo } = context;

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    void Promise.all([
      getCommit(connection, repo.owner, repo.name, oid),
      getCommitDiff(connection, repo.owner, repo.name, oid),
    ])
      .then(([commit, diff]) => {
        if (!cancelled) setData({ commit, diff });
      })
      .catch((cause) => {
        if (!cancelled) setError(cause);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oid, repo.repoId]);

  const body = useMemo(
    () =>
      data === null
        ? ""
        : data.commit.message.split("\n").slice(1).join("\n").trim(),
    [data],
  );

  if (error != null) return <ErrorBox error={error} />;
  if (data === null) return <Spinner />;
  const { commit, diff } = data;
  const files = diff.files;

  return (
    <div>
      {/* commit header */}
      <div className="mb-4 overflow-hidden rounded-md border border-border-muted">
        <div className="px-4 py-3">
          <h2 className="text-base font-semibold">{subject(commit.message)}</h2>
          {body.length > 0 && (
            <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-fg-muted">
              {body}
            </pre>
          )}
          <p className="mt-2 text-xs text-fg-muted">
            <span className="font-semibold text-fg-default">
              {commit.author.name}
            </span>{" "}
            committed {timeAgo(commit.author.date * 1000)}
            {commit.committer.name !== commit.author.name && (
              <> · committed by {commit.committer.name}</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-muted bg-canvas-subtle px-4 py-2 text-xs text-fg-muted">
          <span className="flex items-center gap-1.5">
            {commit.parents.length === 0 ? (
              <span>root commit</span>
            ) : (
              <>
                {commit.parents.length === 1 ? "parent" : "parents"}{" "}
                {commit.parents.map((parent, index) => (
                  <span key={parent}>
                    {index > 0 && <span className="mr-1.5">+</span>}
                    <Link
                      to={href(repo.owner, repo.name, "commit", parent)}
                      className="font-mono text-accent hover:underline"
                    >
                      {shortOid(parent)}
                    </Link>
                  </span>
                ))}
              </>
            )}
          </span>
          <span className="flex items-center gap-1">
            commit{" "}
            <code className="rounded border border-border-muted px-2 py-0.5 font-mono text-accent">
              {shortOid(commit.oid)}
            </code>
            <CopyButton text={commit.oid} />
          </span>
        </div>
      </div>

      {/* summary + truncation notice */}
      <p className="mb-3 text-sm text-fg-muted">
        {files.length} file{files.length === 1 ? "" : "s"} changed
        {diff.parent === null &&
          " (root commit — diffed against the empty tree)"}
      </p>
      {diff.truncated && (
        <div className="mb-3 rounded-md border border-attention/40 bg-attention/5 px-4 py-2 text-sm text-attention">
          This commit changes more files than shown — the list was truncated at{" "}
          {files.length} files by the server.
        </div>
      )}

      {/* file diffs */}
      <FileDiffList context={context} files={files} />
    </div>
  );
};

export default CommitPage;

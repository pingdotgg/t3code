/** The Commits tab: paged history of the selected ref. */
import { useEffect, useState } from "react";
import { getLog, type CommitInfo } from "../client.ts";
import { Button, CopyButton, ErrorBox, Spinner } from "../components.tsx";
import { shortOid, subject, timeAgo } from "../format.ts";
import { href, Link } from "../router.tsx";
import type { RepoContext } from "./Repo.tsx";

const CommitRow = ({
  context,
  commit,
}: {
  context: RepoContext;
  commit: CommitInfo;
}) => {
  const [expanded, setExpanded] = useState(false);
  const body = commit.message.split("\n").slice(1).join("\n").trim();
  const commitHref = href(
    context.repo.owner,
    context.repo.name,
    "commit",
    commit.oid,
  );
  return (
    <li className="border-b border-border-muted px-4 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to={commitHref}
            className="text-left text-sm font-semibold hover:text-accent hover:underline"
          >
            {subject(commit.message)}
          </Link>
          {body.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="ml-2 cursor-pointer rounded border border-border-muted px-1 text-xs text-fg-muted hover:text-accent"
              title={expanded ? "Hide description" : "Show description"}
            >
              …
            </button>
          )}
          <p className="mt-0.5 text-xs text-fg-muted">
            {commit.author.name} committed {timeAgo(commit.author.date * 1000)}
          </p>
          {expanded && body.length > 0 && (
            <pre className="mt-2 overflow-x-auto rounded bg-canvas-subtle p-3 font-mono text-xs whitespace-pre-wrap">
              {body}
            </pre>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            to={commitHref}
            className="rounded border border-border-muted px-2 py-0.5 font-mono text-xs text-accent hover:underline"
          >
            {shortOid(commit.oid)}
          </Link>
          <CopyButton text={commit.oid} />
        </div>
      </div>
    </li>
  );
};

export const CommitsTab = ({ context }: { context: RepoContext }) => {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { connection, repo, refName } = context;

  const load = async (nextCursor?: string) => {
    try {
      const page = await getLog(connection, repo.owner, repo.name, {
        ref: refName,
        limit: 50,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      setCommits((existing) =>
        nextCursor ? [...(existing ?? []), ...page.items] : page.items,
      );
      setCursor(page.hasMore ? page.nextCursor : null);
    } catch (cause) {
      setError(cause);
    }
  };

  useEffect(() => {
    setCommits(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refName, repo.repoId]);

  if (error != null) return <ErrorBox error={error} />;
  if (commits === null) return <Spinner />;

  return (
    <div>
      <ul className="overflow-hidden rounded-md border border-border-muted">
        {commits.map((commit) => (
          <CommitRow key={commit.oid} context={context} commit={commit} />
        ))}
        {commits.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-fg-muted">
            No commits on {refName}
          </li>
        )}
      </ul>
      {cursor !== null && (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => void load(cursor)}>Older commits</Button>
        </div>
      )}
    </div>
  );
};

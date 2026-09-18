/**
 * The Pull requests tab (`/:owner/:repo/pulls`): GitHub-style list with
 * open/closed/merged filter tabs and a "New pull request" form
 * (base/head branch selectors from the refs advertisement) for
 * signed-in users.
 *
 * Deliberately free of `@pierre/diffs` imports — this module is statically
 * imported by `Repo.tsx` and lives in the initial bundle; the diff-heavy
 * detail page (`Pull.tsx`) is a separate lazy chunk.
 */
import { useEffect, useState } from "react";
import { createPull, listPulls, type Pull, type PullState } from "../client.ts";
import {
  Button,
  ErrorBox,
  GitMergeIcon,
  Input,
  PullClosedIcon,
  PullRequestIcon,
  Spinner,
} from "../components.tsx";
import { timeAgo } from "../format.ts";
import { href, Link, useRouter } from "../router.tsx";
import type { RepoContext } from "./Repo.tsx";

// ── shared PR presentation atoms (also used by Pull.tsx) ────────────────────

/** `refs/heads/main` → `main` (display only; API calls keep full names). */
export const shortRef = (ref: string): string =>
  ref.replace(/^refs\/(heads|tags)\//, "");

/** The octicon for a PR state (uncolored — callers pick the tone). */
export const PullStateGlyph = ({
  state,
  className,
}: {
  state: PullState;
  className?: string;
}) =>
  state === "open" ? (
    <PullRequestIcon className={className} />
  ) : state === "merged" ? (
    <GitMergeIcon className={className} />
  ) : (
    <PullClosedIcon className={className} />
  );

/** Foreground tone matching a PR state (list rows, inline glyphs). */
export const stateTone: Record<PullState, string> = {
  open: "text-success",
  merged: "text-done",
  closed: "text-danger",
};

/** GitHub-style filled state pill: green Open, purple Merged, red Closed. */
export const PullStateBadge = ({ state }: { state: PullState }) => (
  <span
    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-fg-on-emphasis ${
      state === "open"
        ? "bg-success-emphasis"
        : state === "merged"
          ? "bg-done-emphasis"
          : "bg-danger-emphasis"
    }`}
  >
    <PullStateGlyph state={state} className="size-3.5" />
    {state === "open" ? "Open" : state === "merged" ? "Merged" : "Closed"}
  </span>
);

// ── list row ────────────────────────────────────────────────────────────────

const PullRow = ({ context, pull }: { context: RepoContext; pull: Pull }) => {
  const { owner, name } = context.repo;
  return (
    <li className="flex items-start gap-3 border-b border-border-muted px-4 py-3 last:border-b-0 hover:bg-canvas-subtle">
      <PullStateGlyph
        state={pull.state}
        className={`mt-0.5 shrink-0 ${stateTone[pull.state]}`}
      />
      <div className="min-w-0 grow">
        <Link
          to={href(owner, name, "pulls", String(pull.number))}
          className="text-sm font-semibold hover:text-accent hover:underline"
        >
          {pull.title}
        </Link>
        <p className="mt-0.5 text-xs text-fg-muted">
          #{pull.number}{" "}
          {pull.state === "merged"
            ? `merged ${timeAgo(pull.mergedAt ?? pull.updatedAt)}`
            : pull.state === "closed"
              ? `closed ${timeAgo(pull.updatedAt)}`
              : `opened ${timeAgo(pull.createdAt)}`}{" "}
          · <code className="font-mono">{shortRef(pull.baseRef)}</code>
          {" ← "}
          <code className="font-mono">{shortRef(pull.headRef)}</code>
        </p>
      </div>
    </li>
  );
};

// ── new pull request form ───────────────────────────────────────────────────

const BranchSelect = ({
  label,
  value,
  onChange,
  branches,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  branches: string[];
}) => (
  <label className="inline-flex items-center gap-1.5 rounded-md border border-border-muted bg-canvas px-2.5 py-1.5 text-sm">
    <span className="text-fg-muted">{label}:</span>
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="cursor-pointer appearance-none bg-transparent font-medium outline-none"
    >
      {branches.map((branch) => (
        <option key={branch} value={branch}>
          {branch}
        </option>
      ))}
    </select>
  </label>
);

const NewPullForm = ({
  context,
  onCreated,
}: {
  context: RepoContext;
  onCreated: (pull: Pull) => void;
}) => {
  const branches = context.refs.refs
    .filter((ref) => ref.name.startsWith("refs/heads/"))
    .map((ref) => shortRef(ref.name));
  const defaultBase = branches.includes(context.repo.defaultBranch)
    ? context.repo.defaultBranch
    : (branches[0] ?? "");
  const [base, setBase] = useState(defaultBase);
  const [head, setHead] = useState(
    branches.find((branch) => branch !== defaultBase) ?? defaultBase,
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { connection, repo } = context;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const pull = await createPull(connection, repo.owner, repo.name, {
        title: title.trim(),
        base,
        head,
        ...(body.trim() ? { body: body.trim() } : {}),
      });
      onCreated(pull);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mb-4 space-y-3 rounded-md border border-border-muted bg-canvas-subtle p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <BranchSelect
          label="base"
          value={base}
          onChange={setBase}
          branches={branches}
        />
        <span className="text-fg-muted">←</span>
        <BranchSelect
          label="compare"
          value={head}
          onChange={setHead}
          branches={branches}
        />
        {head === base && (
          <span className="text-xs text-attention">
            choose two different branches
          </span>
        )}
      </div>
      <Input value={title} onChange={setTitle} placeholder="Title" />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Description (optional, Markdown)"
        rows={5}
        className="w-full rounded-md border border-border-muted bg-canvas px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      {error != null && <ErrorBox error={error} />}
      <Button
        kind="primary"
        type="submit"
        disabled={busy || title.trim().length === 0 || head === base}
      >
        {busy ? "Creating…" : "Create pull request"}
      </Button>
    </form>
  );
};

// ── the tab ─────────────────────────────────────────────────────────────────

const FILTERS: PullState[] = ["open", "closed", "merged"];

export const PullsTab = ({ context }: { context: RepoContext }) => {
  const [filter, setFilter] = useState<PullState>("open");
  const [pulls, setPulls] = useState<Pull[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showNew, setShowNew] = useState(false);
  const { navigate } = useRouter();
  const { connection, repo } = context;
  const signedIn = context.user !== null;

  const load = async (state: PullState, nextCursor?: string) => {
    try {
      const page = await listPulls(connection, repo.owner, repo.name, {
        state,
        limit: 50,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      setPulls((existing) =>
        nextCursor ? [...(existing ?? []), ...page.items] : page.items,
      );
      setCursor(page.hasMore ? page.nextCursor : null);
    } catch (cause) {
      setError(cause);
    }
  };

  useEffect(() => {
    setPulls(null);
    setError(null);
    void load(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, repo.repoId]);

  if (error != null) return <ErrorBox error={error} />;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-md border border-border-muted p-0.5">
          {FILTERS.map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => setFilter(state)}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded px-3 py-1 text-sm capitalize ${
                filter === state
                  ? "bg-canvas-subtle font-semibold"
                  : "text-fg-muted hover:text-fg-default"
              }`}
            >
              <PullStateGlyph
                state={state}
                className={`size-3.5 ${filter === state ? stateTone[state] : ""}`}
              />
              {state}
            </button>
          ))}
        </div>
        {signedIn && (
          <Button kind="primary" onClick={() => setShowNew((value) => !value)}>
            New pull request
          </Button>
        )}
      </div>

      {showNew && (
        <NewPullForm
          context={context}
          onCreated={(pull) =>
            navigate(href(repo.owner, repo.name, "pulls", String(pull.number)))
          }
        />
      )}

      {pulls === null ? (
        <Spinner />
      ) : (
        <>
          <ul className="overflow-hidden rounded-md border border-border-muted">
            {pulls.map((pull) => (
              <PullRow key={pull.number} context={context} pull={pull} />
            ))}
            {pulls.length === 0 && (
              <li className="px-4 py-12 text-center text-sm text-fg-muted">
                No {filter} pull requests
                {filter === "open" && signedIn && " — create one above."}
              </li>
            )}
          </ul>
          {cursor !== null && (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => void load(filter, cursor)}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

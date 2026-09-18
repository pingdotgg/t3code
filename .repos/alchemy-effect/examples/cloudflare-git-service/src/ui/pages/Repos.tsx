/** The home page: all repositories, GitHub-dashboard style. */
import { useEffect, useState } from "react";
import {
  createRepo,
  listRepos,
  type Connection,
  type Repo,
  type RepoCreated,
  type User,
} from "../client.ts";
import {
  Badge,
  Button,
  CopyButton,
  ErrorBox,
  ForkIcon,
  Input,
  RepoIcon,
  Spinner,
} from "../components.tsx";
import { timeAgo } from "../format.ts";
import { href, Link } from "../router.tsx";

const RepoRow = ({ repo }: { repo: Repo }) => (
  <li className="flex items-start justify-between gap-4 border-b border-border-muted py-4 last:border-b-0">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <RepoIcon className="shrink-0 text-fg-muted" />
        <Link
          to={href(repo.owner, repo.name)}
          className="truncate text-base font-semibold text-accent hover:underline"
        >
          {repo.owner}/{repo.name}
        </Link>
        {repo.forkOf !== null && (
          <Badge>
            <span className="inline-flex items-center gap-1">
              <ForkIcon className="size-3" /> fork of {repo.forkOf}
            </span>
          </Badge>
        )}
        <Badge>{repo.public ? "Public" : "Private"}</Badge>
        {repo.readOnly && <Badge tone="attention">read-only</Badge>}
        {repo.status !== "ready" && <Badge tone="danger">{repo.status}</Badge>}
      </div>
      {repo.description !== null && repo.description.length > 0 && (
        <p className="mt-1 text-sm text-fg-muted">{repo.description}</p>
      )}
      {/* No size here: the list renders from the registry's denormalized
          columns, which don't carry object stats (that would re-create the
          one-DO-wake-per-row N+1 the list was built to avoid). */}
      <p className="mt-1.5 text-xs text-fg-muted">
        created {timeAgo(repo.createdAt)}
      </p>
    </div>
  </li>
);

/** Post-create panel: the remote to add. The password is one of your API keys. */
const CreatedPanel = ({ created }: { created: RepoCreated }) => (
  <div className="mb-4 space-y-3 rounded-md border border-success/40 bg-success/5 p-4 text-sm">
    <p className="font-medium text-success">
      Repository {created.repo.owner}/{created.repo.name} created. Push with one
      of your API keys as the password (Settings → API keys).
    </p>
    <div className="flex items-center gap-2">
      <code className="grow overflow-x-auto rounded bg-canvas-subtle px-2 py-1 font-mono text-xs">
        git remote add origin{" "}
        {created.remote.replace("://", "://x:YOUR_API_KEY@")}
      </code>
      <CopyButton
        text={`git remote add origin ${created.remote.replace("://", "://x:YOUR_API_KEY@")}`}
      />
    </div>
  </div>
);

const NewRepoForm = ({
  connection,
  user,
  onCreated,
}: {
  connection: Connection;
  user: User;
  onCreated: (created: RepoCreated) => void;
}) => {
  // Repositories are owned by a principal's id, so the owner is you.
  const [owner, setOwner] = useState(user.id);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createRepo(connection, {
        owner: owner.trim(),
        name: name.trim(),
        public: isPublic,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onCreated(created);
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
      <div className="flex gap-2">
        <Input value={owner} onChange={setOwner} placeholder="owner" mono />
        <span className="self-center text-fg-muted">/</span>
        <Input value={name} onChange={setName} placeholder="name" mono />
      </div>
      <Input
        value={description}
        onChange={setDescription}
        placeholder="Description (optional)"
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(event) => setIsPublic(event.target.checked)}
        />
        Public — anyone can read and clone without signing in
      </label>
      {error != null && <ErrorBox error={error} />}
      <Button kind="primary" type="submit" disabled={busy || !owner || !name}>
        {busy ? "Creating…" : "Create repository"}
      </Button>
    </form>
  );
};

export const ReposPage = ({
  connection,
  user,
}: {
  connection: Connection;
  user: User | null;
}) => {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showNew, setShowNew] = useState(false);
  const [created, setCreated] = useState<RepoCreated | null>(null);

  const load = async (nextCursor?: string) => {
    try {
      const page = await listRepos(connection, {
        limit: 50,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      setRepos((existing) =>
        nextCursor ? [...(existing ?? []), ...page.items] : page.items,
      );
      setCursor(page.hasMore ? page.nextCursor : null);
    } catch (cause) {
      setError(cause);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.url, user?.id]);

  if (error != null) return <ErrorBox error={error} />;
  if (repos === null) return <Spinner />;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Repositories</h1>
        {user !== null && (
          <Button kind="primary" onClick={() => setShowNew((value) => !value)}>
            New repository
          </Button>
        )}
      </div>
      {created !== null && <CreatedPanel created={created} />}
      {showNew && user !== null && (
        <NewRepoForm
          connection={connection}
          user={user}
          onCreated={(result) => {
            setCreated(result);
            setShowNew(false);
            void load();
          }}
        />
      )}
      {repos.length === 0 ? (
        <div className="rounded-md border border-border-muted py-16 text-center text-fg-muted">
          No repositories yet — create one to get started.
        </div>
      ) : (
        <ul>
          {repos.map((repo) => (
            <RepoRow key={repo.repoId} repo={repo} />
          ))}
        </ul>
      )}
      {cursor !== null && (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => void load(cursor)}>Load more</Button>
        </div>
      )}
    </div>
  );
};

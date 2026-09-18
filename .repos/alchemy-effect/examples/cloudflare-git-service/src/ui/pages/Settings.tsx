/** The Settings tab: API keys, storage stats, compaction, delete. */
import { useEffect, useState } from "react";
import {
  compactRepo,
  createApiKey,
  deleteApiKey,
  deleteRepo,
  listApiKeys,
  updateRepo,
  type ApiKey,
} from "../client.ts";
import {
  Badge,
  Button,
  CopyButton,
  ErrorBox,
  Input,
  Spinner,
} from "../components.tsx";
import { formatBytes, timeAgo } from "../format.ts";
import { useRouter } from "../router.tsx";
import type { RepoContext } from "./Repo.tsx";

const StorageCard = ({ context }: { context: RepoContext }) => {
  const { objects, lastPush } = context.repo;
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="rounded-md border border-border-muted p-4">
      <h2 className="mb-3 font-semibold">Storage</h2>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-fg-muted">Total</dt>
        <dd>{formatBytes(objects.bytes)}</dd>
        <dt className="text-fg-muted">Loose objects</dt>
        <dd>{objects.loose}</dd>
        <dt className="text-fg-muted">Packed (R2)</dt>
        <dd>{objects.packed}</dd>
        <dt className="text-fg-muted">Oversize (R2)</dt>
        <dd>{objects.r2}</dd>
      </dl>
      {lastPush !== null && (
        <p className="mt-3 text-xs text-fg-muted">
          Last push: {lastPush.objects} objects, {formatBytes(lastPush.bytes)} —
          server ingest {lastPush.ingestMs}ms (sql {lastPush.stageMs}ms), total{" "}
          {lastPush.totalMs}ms
        </p>
      )}
      <div className="mt-3">
        <Button
          disabled={compacting || objects.loose === 0}
          onClick={() => {
            setCompacting(true);
            setError(null);
            compactRepo(
              context.connection,
              context.repo.owner,
              context.repo.name,
            )
              .then(() => setCompacting(false))
              .catch((cause) => {
                setError(cause);
                setCompacting(false);
              });
          }}
        >
          {compacting ? "Compaction scheduled ✓" : "Compact loose objects"}
        </Button>
      </div>
      {error != null && <ErrorBox error={error} />}
    </section>
  );
};

const VisibilityCard = ({ context }: { context: RepoContext }) => {
  const [isPublic, setIsPublic] = useState(context.repo.public);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="rounded-md border border-border-muted p-4">
      <h2 className="mb-2 font-semibold">Visibility</h2>
      <p className="mb-3 text-sm text-fg-muted">
        {isPublic
          ? "Public — anyone can browse and clone this repository without a token."
          : "Private — reads and clones require a token."}
      </p>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          updateRepo(
            context.connection,
            context.repo.owner,
            context.repo.name,
            {
              public: !isPublic,
            },
          )
            .then((updated) => {
              setIsPublic(updated.public);
              setBusy(false);
            })
            .catch((cause) => {
              setError(cause);
              setBusy(false);
            });
        }}
      >
        {busy ? "Saving…" : isPublic ? "Make private" : "Make public"}
      </Button>
      {error != null && <ErrorBox error={error} />}
    </section>
  );
};

const ApiKeysCard = ({ context }: { context: RepoContext }) => {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [minted, setMinted] = useState<(ApiKey & { key: string }) | null>(null);
  const { connection, repo } = context;
  const remote = `${connection.url}/${repo.owner}/${repo.name}.git`;

  const load = () =>
    listApiKeys(connection)
      .then((items) => setKeys(items))
      .catch(setError);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="rounded-md border border-border-muted p-4">
      <h2 className="mb-1 font-semibold">API keys</h2>
      <p className="mb-3 text-sm text-fg-muted">
        A key is the password of your git remote. Keys belong to your account
        and work on every repository you own.
      </p>
      {minted !== null && (
        <div className="mb-3 space-y-2 rounded-md border border-success/40 bg-success/5 p-3 text-sm">
          <p className="font-medium text-success">
            Key “{minted.name}” created — shown exactly once:
          </p>
          <div className="flex items-center gap-2">
            <code className="grow overflow-x-auto rounded bg-canvas-subtle px-2 py-1 font-mono text-xs">
              git remote add origin{" "}
              {remote.replace("://", `://x:${minted.key}@`)}
            </code>
            <CopyButton
              text={`git remote add origin ${remote.replace("://", `://x:${minted.key}@`)}`}
            />
          </div>
        </div>
      )}
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          createApiKey(connection, name.trim())
            .then((key) => {
              setMinted(key);
              setName("");
              void load();
            })
            .catch(setError);
        }}
      >
        <div className="w-48">
          <Input value={name} onChange={setName} placeholder="Key name" />
        </div>
        <Button
          kind="primary"
          type="submit"
          disabled={name.trim().length === 0}
        >
          Generate key
        </Button>
      </form>
      {error != null && <ErrorBox error={error} />}
      {keys === null ? (
        <Spinner />
      ) : keys.length === 0 ? (
        <p className="text-sm text-fg-muted">No keys.</p>
      ) : (
        <ul className="divide-y divide-border-muted">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex items-center justify-between gap-4 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{key.name ?? "unnamed"}</span>
                {key.start !== null && <Badge>{key.start}…</Badge>}
                <span className="text-xs text-fg-muted">
                  created {timeAgo(new Date(key.createdAt).getTime())}
                </span>
              </div>
              <Button
                kind="danger"
                onClick={() => {
                  deleteApiKey(connection, key.id)
                    .then(() => void load())
                    .catch(setError);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const DangerCard = ({ context }: { context: RepoContext }) => {
  const { navigate } = useRouter();
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const full = `${context.repo.owner}/${context.repo.name}`;
  return (
    <section className="rounded-md border border-danger/40 p-4">
      <h2 className="mb-2 font-semibold text-danger">Danger zone</h2>
      <p className="mb-3 text-sm text-fg-muted">
        Deleting a repository destroys its refs and objects. Type{" "}
        <code className="font-mono">{full}</code> to confirm.
      </p>
      <div className="flex items-center gap-2">
        <div className="w-64">
          <Input
            value={confirm}
            onChange={setConfirm}
            placeholder={full}
            mono
          />
        </div>
        <Button
          kind="danger"
          disabled={confirm !== full || busy}
          onClick={() => {
            setBusy(true);
            deleteRepo(
              context.connection,
              context.repo.owner,
              context.repo.name,
            )
              .then(() => navigate("/"))
              .catch((cause) => {
                setError(cause);
                setBusy(false);
              });
          }}
        >
          {busy ? "Deleting…" : "Delete this repository"}
        </Button>
      </div>
      {error != null && <ErrorBox error={error} />}
    </section>
  );
};

export const SettingsTab = ({ context }: { context: RepoContext }) => (
  <div className="space-y-4">
    <StorageCard context={context} />
    <VisibilityCard context={context} />
    <ApiKeysCard context={context} />
    <DangerCard context={context} />
  </div>
);

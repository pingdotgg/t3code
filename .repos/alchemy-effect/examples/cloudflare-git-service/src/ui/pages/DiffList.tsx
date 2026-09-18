/**
 * Shared changed-file renderer used by the commit view (`Commit.tsx`)
 * and the pull-request view (`Pull.tsx`): one card per `DiffEntry` with
 * a status badge header and a `@pierre/diffs` `<FileDiff>` body, plus
 * "Show more files" pagination.
 *
 * IMPORTANT: this module imports the diffs+shiki runtime (via
 * `../diff.tsx`). Only `React.lazy` chunks may import it — never
 * `main.tsx`/`Repo.tsx` statically — so the library stays out of the
 * initial bundle.
 *
 * Each card fetches its own old/new blob contents by oid (shared
 * 4-concurrent limiter) and diffs locally. Gitlinks, mode-only changes,
 * oversize and binary blobs render placeholder rows and never
 * fetch/parse.
 */
import {
  parseDiffFromFile,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useEffect, useState, type ReactNode } from "react";
import { getBlob, type DiffEntry, type FileStatus } from "../client.ts";
import { Button, ErrorBox } from "../components.tsx";
import { blobLimiter, MAX_RENDER_BYTES, useFileDiffOptions } from "../diff.tsx";
import { decodeText, formatBytes } from "../format.ts";
import type { RepoContext } from "./Repo.tsx";

// ── per-file diff card ──────────────────────────────────────────────────────

type FileState =
  | { kind: "loading" }
  | { kind: "text"; fileDiff: FileDiffMetadata }
  | { kind: "binary" }
  | { kind: "error"; error: unknown };

const StatusBadge = ({ status }: { status: FileStatus }) => (
  <span
    className={`shrink-0 rounded-full border px-2 py-0.5 font-medium ${
      status === "added"
        ? "border-success/40 text-success"
        : status === "removed"
          ? "border-danger/40 text-danger"
          : "border-attention/40 text-attention"
    }`}
  >
    {status}
  </span>
);

/** Placeholder body for files we deliberately don't render as a diff. */
const NoteRow = ({ children }: { children: ReactNode }) => (
  <div className="px-4 py-6 text-center text-sm text-fg-muted">{children}</div>
);

const sizeLabel = (entry: DiffEntry): string | null => {
  const size = entry.newSize ?? entry.oldSize;
  return size == null ? null : formatBytes(size);
};

export const FileDiffCard = ({
  context,
  entry,
}: {
  context: RepoContext;
  entry: DiffEntry;
}) => {
  const options = useFileDiffOptions();
  const { connection, repo } = context;

  // Cases that never fetch contents.
  const gitlink = entry.oldMode === "160000" || entry.newMode === "160000";
  const modeOnly =
    entry.status === "modified" &&
    entry.oldOid != null &&
    entry.oldOid === entry.newOid;
  const oversize =
    (entry.oldSize ?? 0) > MAX_RENDER_BYTES ||
    (entry.newSize ?? 0) > MAX_RENDER_BYTES;
  const skip = gitlink || modeOnly || oversize;

  const [state, setState] = useState<FileState>({ kind: "loading" });

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    setState({ kind: "loading" });
    void blobLimiter(async () => {
      // Absent sides arrive as null over JSON (added/removed files) —
      // treat null and undefined alike or we fetch "blobs/null".
      const side = (
        oid: string | null | undefined,
        size: number | null | undefined,
      ) =>
        oid == null
          ? Promise.resolve(null)
          : getBlob(connection, repo.owner, repo.name, oid, {
              size: size ?? undefined,
            });
      const [oldBytes, newBytes] = await Promise.all([
        side(entry.oldOid, entry.oldSize),
        side(entry.newOid, entry.newSize),
      ]);
      if (cancelled) return;
      const oldText = oldBytes === null ? null : decodeText(oldBytes);
      const newText = newBytes === null ? null : decodeText(newBytes);
      // A side that exists but doesn't decode as UTF-8 is binary.
      if (
        (oldBytes !== null && oldText === null) ||
        (newBytes !== null && newText === null)
      ) {
        setState({ kind: "binary" });
        return;
      }
      // The blob oid is a perfect cacheKey: content-addressed identity.
      const contents = (
        text: string | null,
        oid: string | null | undefined,
      ): FileContents | null =>
        text === null
          ? null
          : { name: entry.path, contents: text, cacheKey: oid ?? undefined };
      // The server guarantees ≥ 1 side, so this never sees (null, null).
      const fileDiff = parseDiffFromFile(
        contents(oldText, entry.oldOid),
        contents(newText, entry.newOid),
      );
      setState({ kind: "text", fileDiff });
    }).catch((error: unknown) => {
      if (!cancelled) setState({ kind: "error", error });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.oldOid, entry.newOid, skip, repo.repoId]);

  const size = sizeLabel(entry);
  const modeChanged =
    entry.oldMode !== undefined &&
    entry.newMode !== undefined &&
    entry.oldMode !== entry.newMode;

  return (
    <div className="overflow-hidden rounded-md border border-border-muted">
      <div className="flex items-center justify-between gap-3 border-b border-border-muted bg-canvas-subtle px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <StatusBadge status={entry.status} />
          <span className="truncate font-mono">{entry.path}</span>
          {modeChanged && (
            <span className="shrink-0 text-fg-muted">
              {entry.oldMode} → {entry.newMode}
            </span>
          )}
        </div>
        {size !== null && (
          <span className="shrink-0 text-fg-muted">{size}</span>
        )}
      </div>
      {gitlink ? (
        <NoteRow>
          Subproject commit{" "}
          <code className="font-mono">{entry.newOid ?? entry.oldOid}</code>
        </NoteRow>
      ) : modeOnly ? (
        <NoteRow>File mode changed — contents unchanged</NoteRow>
      ) : oversize ? (
        <NoteRow>Large file not rendered ({size})</NoteRow>
      ) : state.kind === "loading" ? (
        <div className="flex justify-center py-6">
          <div className="size-5 animate-spin rounded-full border-2 border-border-muted border-t-accent" />
        </div>
      ) : state.kind === "binary" ? (
        <NoteRow>Binary file not shown{size !== null && ` (${size})`}</NoteRow>
      ) : state.kind === "error" ? (
        <ErrorBox error={state.error} />
      ) : (
        <FileDiff fileDiff={state.fileDiff} options={options} />
      )}
    </div>
  );
};

// ── the paged list ──────────────────────────────────────────────────────────

/** Files rendered before the "Show more" affordance kicks in. */
const PAGE_SIZE = 25;

/** Paged list of file-diff cards (resets paging when `files` changes). */
const FileDiffList = ({
  context,
  files,
}: {
  context: RepoContext;
  files: DiffEntry[];
}) => {
  const [visible, setVisible] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [files]);

  return (
    <div>
      <div className="flex flex-col gap-4">
        {files.slice(0, visible).map((entry) => (
          <FileDiffCard
            key={`${entry.status}:${entry.path}`}
            context={context}
            entry={entry}
          />
        ))}
        {files.length === 0 && (
          <div className="rounded-md border border-border-muted px-4 py-8 text-center text-sm text-fg-muted">
            No changes
          </div>
        )}
      </div>
      {visible < files.length && (
        <div className="mt-4 flex justify-center">
          <Button onClick={() => setVisible((count) => count + PAGE_SIZE)}>
            Show more files ({files.length - visible} remaining)
          </Button>
        </div>
      )}
    </div>
  );
};

export default FileDiffList;

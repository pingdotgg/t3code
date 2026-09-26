/**
 * Editor session for one workspace path. A package-owned
 * FileEditCoordinator drives debounced autosave through the revisioned
 * `t3.workspace/text-edits@1.1.0` contract: the textarea renders the buffered
 * contents optimistically, saves compare-and-swap on the confirmed base
 * revision, conflicts halt autosave until the user resolves them, and the
 * session flushes pending edits when the file changes or the view unmounts —
 * the native panel's unmount-dispose semantics.
 *
 * Past the checkpoint's 24,000-byte bound the same semantics
 * ride `t3.workspace/resources`: opens fall through to the chunked,
 * sha256-verified `read` stream and saves become a `save.begin`/`save.chunk`/
 * `save.commit` upload carrying the same expected-revision compare-and-swap.
 */

import {
  EDITABLE_TEXT_MAX_BYTES,
  splitWorkspaceResourceChunks,
  textEditsApi,
  workspaceResourcesApi,
  WORKSPACE_RESOURCE_MAX_BYTES,
  type WorkspaceResourceReason,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useEffect, useRef, useState } from "react";

import { FILE_SAVE_DEBOUNCE_MS, FileEditCoordinator } from "./saveCoordinator.ts";
import type { EditorSaveState, PersistOutcome } from "./saveCoordinator.ts";
import {
  collectResourceRead,
  describeResourceRead,
  describeSnapshot,
  sha256Hex,
} from "./viewModel.ts";
import type { EditorOpen, PreviewKind } from "./viewModel.ts";

export interface EditorSurface {
  readonly path: string;
  readonly open: EditorOpen;
  readonly contents: string;
  readonly saveState: EditorSaveState;
}

const textEncoder = new TextEncoder();

/** Every resource save failure reason → one honest user-facing message. */
const RESOURCE_SAVE_MESSAGES: Readonly<Record<WorkspaceResourceReason, string>> = {
  "not-found": "the file no longer exists",
  "not-regular-file": "the target is not a regular file",
  binary: "binary contents cannot be saved as text",
  "invalid-utf8": "the contents are not valid UTF-8",
  oversized: `the contents exceed the ${WORKSPACE_RESOURCE_MAX_BYTES.toLocaleString("en-US")}-byte workspace resource bound`,
  "outside-workspace": "the path resolves outside the workspace",
  "unsafe-path": "the path is not a safe workspace-relative path",
  "changed-during-read": "the file changed while it was being read",
  aborted: "the save was aborted",
  "io-error": "the file could not be written",
  "unknown-upload": "the upload session expired",
  "upload-limit": "the host's upload session limit is reached",
  "upload-incomplete": "the upload ended before all declared chunks arrived",
  "digest-mismatch": "the uploaded contents failed host-side verification",
};

const resourceSaveError = (reason: WorkspaceResourceReason): PersistOutcome => ({
  kind: "error",
  message: `Save failed — ${RESOURCE_SAVE_MESSAGES[reason]}`,
});

/**
 * The >24,000-byte write path: declare the complete contents' byte length and
 * sha256 up front, upload ≤8192-unit chunks in strict order, then commit —
 * the host verifies the digest and runs the same serialized compare-and-swap
 * as the unary save. A failure mid-upload abandons the session with a
 * best-effort abort; the host also reclaims abandoned sessions itself.
 */
async function persistResourceSave(options: {
  readonly host: ClientHost;
  readonly session: ViewSession;
  readonly path: string;
  readonly contents: string;
  readonly expectedRevision: string;
}): Promise<PersistOutcome> {
  const api = bindApi(workspaceResourcesApi, options.host, options.session.context);
  const signal = options.session.signal;
  const chunks = splitWorkspaceResourceChunks(options.contents);
  const begin = await api.invoke(
    "save.begin",
    {
      relativePath: options.path,
      expectedRevision: options.expectedRevision,
      byteLength: textEncoder.encode(options.contents).byteLength,
      chunkCount: chunks.length,
      sha256: await sha256Hex(options.contents),
    },
    signal,
  );
  if (begin.kind !== "session") return resourceSaveError(begin.reason);
  const uploadId = begin.uploadId;
  const abort = () => void api.invoke("save.abort", { uploadId }, signal).catch(() => undefined);
  try {
    for (const [chunkIndex, data] of chunks.entries()) {
      const accepted = await api.invoke("save.chunk", { uploadId, chunkIndex, data }, signal);
      if (accepted.kind !== "accepted") {
        abort();
        return resourceSaveError(accepted.reason);
      }
    }
    const commit = await api.invoke("save.commit", { uploadId }, signal);
    if (commit.kind === "saved") return { kind: "saved", revision: commit.revision };
    if (commit.kind === "conflict") return { kind: "conflict" };
    return resourceSaveError(commit.reason);
  } catch (error) {
    abort();
    throw error;
  }
}

/**
 * One open-path read: the 24,000-byte snapshot first, then — only for the
 * `oversized` checkpoint gap — the resource stream's complete verified
 * transfer. Other not-editable reasons stay named as-is; a cancelled stream
 * returns null so callers leave state untouched.
 */
async function openRead(
  host: ClientHost,
  session: ViewSession,
  path: string,
  signal: AbortSignal,
): Promise<EditorOpen | null> {
  const snapshot = await bindApi(textEditsApi, host, session.context).invoke(
    "readSnapshot",
    { relativePath: path },
    signal,
  );
  const open = describeSnapshot(snapshot);
  if (open.editable || open.reason !== "oversized") return open;
  const read = await collectResourceRead(
    bindStreamApi(workspaceResourcesApi, host, session.context).subscribe(
      "read",
      { relativePath: path },
      signal,
    ),
    signal,
  );
  if (read.kind === "cancelled") return null;
  return describeResourceRead(read);
}

export function useFileEditor(
  host: ClientHost,
  session: ViewSession,
  selected: string | null,
  selectedKind: PreviewKind,
  refreshRevision: number,
  visible: boolean,
) {
  const [surface, setSurface] = useState<EditorSurface | null>(null);
  /**
   * `baseBytes` is the UTF-8 size of that file's confirmed base and lives on
   * the record, not in shared hook state: a delayed save landing after a path
   * switch (dispose flushes pending edits into an in-flight persist) must
   * never corrupt the next file's baseline.
   */
  const activeRef = useRef<{
    path: string;
    coordinator: FileEditCoordinator;
    baseBytes: number;
  } | null>(null);
  const lastRefreshRef = useRef(-1);
  const editing = selected !== null && selectedKind === "text" && visible;

  useEffect(() => {
    const active = activeRef.current;
    if (!editing || selected === null) {
      if (active) {
        active.coordinator.dispose();
        activeRef.current = null;
      }
      // A stale surface is filtered at render (`surface.path === selected`), so
      // nothing to clear synchronously here.
      return;
    }

    const path = selected;
    // This effect's controller bounds only the refresh-read lifetime: each
    // rerun aborts it so a superseded readSnapshot cannot overwrite newer
    // state. The coordinator's persist deliberately uses `session.signal`
    // instead — the session outlives refresh cycles, and a coordinator
    // retained across one must still be able to save (and flush on dispose).
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    let current = activeRef.current;
    const pathChanged = !current || current.path !== path;
    // Re-read the snapshot on open and on every tree refresh; identical
    // revisions skip the network round-trip.
    if (!pathChanged && refreshRevision === lastRefreshRef.current) {
      return () => controller.abort();
    }
    lastRefreshRef.current = refreshRevision;
    if (pathChanged) {
      current?.coordinator.dispose();
      const record = { path, baseBytes: 0 } as {
        path: string;
        coordinator: FileEditCoordinator;
        baseBytes: number;
      };
      record.coordinator = new FileEditCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        persist: async (contents, expectedRevision) => {
          try {
            // Route on both endpoints of the swap, not just the new contents:
            // the unary save also re-reads the on-disk base under the
            // 24,000-byte bound, so shrinking a large file below it must still
            // take the resource path. The revision format is identical across
            // both contracts either way.
            const nextBytes = textEncoder.encode(contents).byteLength;
            if (
              nextBytes <= EDITABLE_TEXT_MAX_BYTES &&
              record.baseBytes <= EDITABLE_TEXT_MAX_BYTES
            ) {
              const saved = await bindApi(textEditsApi, host, session.context).invoke(
                "save",
                { relativePath: path, expectedRevision, contents },
                session.signal,
              );
              if (saved.kind === "saved") record.baseBytes = nextBytes;
              return saved;
            }
            const outcome = await persistResourceSave({
              host,
              session,
              path,
              contents,
              expectedRevision,
            });
            if (outcome.kind === "saved") record.baseBytes = nextBytes;
            return outcome;
          } catch (error) {
            return {
              kind: "error",
              message: error instanceof Error ? error.message : "Save failed",
            };
          }
        },
        onStateChange: (saveState) =>
          setSurface((previous) =>
            previous && previous.path === path ? { ...previous, saveState } : previous,
          ),
      });
      current = record;
      activeRef.current = current;
    }
    const coordinator = current!.coordinator;

    void (async () => {
      try {
        const open = await openRead(host, session, path, signal);
        if (open === null || signal.aborted) return;
        if (!open.editable) {
          setSurface({ path, open, contents: "", saveState: coordinator.state() });
          return;
        }
        const kind = coordinator.state().kind;
        if (kind === "dirty" || kind === "saving" || kind === "error") {
          // Refresh reconciliation: the remote file moved under pending edits —
          // latch the conflict rather than clobbering the user's buffer.
          coordinator.noteRemoteRevision(open.revision);
          setSurface((previous) => ({
            path,
            open,
            contents: previous?.path === path ? previous.contents : coordinator.contents(),
            saveState: coordinator.state(),
          }));
        } else {
          current!.baseBytes = textEncoder.encode(open.contents).byteLength;
          coordinator.seed(open.revision, open.contents);
          setSurface({
            path,
            open,
            contents: open.contents,
            saveState: coordinator.state(),
          });
        }
      } catch (error) {
        if (!signal.aborted)
          setSurface((previous) => ({
            path,
            open: {
              editable: false,
              reason: "io-error",
              message: error instanceof Error ? error.message : "File could not be read",
            },
            contents: previous?.path === path ? previous.contents : "",
            saveState: coordinator.state(),
          }));
      }
    })();
    return () => controller.abort();
  }, [host, session, selected, editing, refreshRevision]);

  // Unmount flush: pending edits persist, exactly like the native panel's
  // coordinator disposal.
  useEffect(
    () => () => {
      activeRef.current?.coordinator.dispose();
      activeRef.current = null;
    },
    [],
  );

  const change = (contents: string) => {
    const active = activeRef.current;
    if (!active || active.path !== selected) return;
    active.coordinator.change(contents);
    setSurface((previous) =>
      previous && previous.path === selected ? { ...previous, contents } : previous,
    );
  };

  /** Reload: discard local edits and adopt the remote snapshot. */
  const reload = () => {
    const active = activeRef.current;
    if (!active || active.path !== selected) return;
    const coordinator = active.coordinator;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void openRead(host, session, active.path, signal)
      .then((open) => {
        if (open === null || signal.aborted) return;
        if (open.editable) {
          active.baseBytes = textEncoder.encode(open.contents).byteLength;
          coordinator.adoptRemote(open.contents, open.revision);
          setSurface({
            path: active.path,
            open,
            contents: open.contents,
            saveState: coordinator.state(),
          });
        } else {
          setSurface((previous) =>
            previous && previous.path === active.path
              ? { ...previous, open, saveState: coordinator.state() }
              : previous,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => controller.abort());
  };

  /** Keep mine: deliberately write the buffer over the fresh remote revision. */
  const keepMine = () => {
    const active = activeRef.current;
    if (!active || active.path !== selected) return;
    const coordinator = active.coordinator;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void openRead(host, session, active.path, signal)
      .then((open) => {
        if (open === null || signal.aborted) return;
        if (open.editable) {
          // The remote snapshot becomes the base the buffer writes over.
          active.baseBytes = textEncoder.encode(open.contents).byteLength;
          coordinator.forcePersist(open.revision);
        } else
          setSurface((previous) =>
            previous && previous.path === active.path
              ? { ...previous, open, saveState: coordinator.state() }
              : previous,
          );
      })
      .catch(() => undefined)
      .finally(() => controller.abort());
  };

  const retry = () => activeRef.current?.coordinator.retry();

  return { surface, change, reload, keepMine, retry };
}

import { useCallback, useEffect, useState } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { readLocalApi } from "../localApi";
import { filesystemEnvironment } from "../state/filesystem";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** The minimum a project needs to surface in this dialog: a `.code-workspace`. */
export interface ProjectFoldersDialogTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** Absolute path to the backing `.code-workspace`; only set for multi-repo projects. */
  readonly workspaceFile: string;
}

/** A single editable folder row, seeded from the server's resolved read. */
interface FolderRow {
  /** Stable key for React lists (the resolved absolute path is unique within a workspace). */
  readonly key: string;
  /** Path as it should be written back (verbatim for existing entries; absolute for new ones). */
  readonly path: string;
  /** Explicit display name to preserve, or `undefined` to let VS Code derive it. */
  readonly name: string | undefined;
  readonly absolutePath: string;
  readonly exists: boolean;
  readonly isGit: boolean;
  /** True for folders added in this session that have not been re-resolved on disk yet. */
  readonly isNew: boolean;
}

function basename(input: string): string {
  const segments = input.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? input;
}

/**
 * Convert a server-resolved folder into an editable row. `name` is only kept
 * when it was explicit in the file (i.e. differs from the resolved basename),
 * so a plain round-trip never injects redundant `name` keys.
 */
function rowFromResolved(folder: {
  readonly rawPath: string;
  readonly name: string;
  readonly absolutePath: string;
  readonly exists: boolean;
  readonly isGit: boolean;
}): FolderRow {
  const derived = basename(folder.absolutePath);
  return {
    key: folder.absolutePath,
    path: folder.rawPath,
    name: folder.name === derived ? undefined : folder.name,
    absolutePath: folder.absolutePath,
    exists: folder.exists,
    isGit: folder.isGit,
    isNew: false,
  };
}

type LoadStatus = "loading" | "ready" | "error";

export function ProjectFoldersDialog({
  target,
  onClose,
}: {
  readonly target: ProjectFoldersDialogTarget | null;
  readonly onClose: () => void;
}): React.ReactNode {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);

  const workspaceFile = target?.workspaceFile ?? null;
  const environmentId = target?.environmentId ?? null;

  // Filesystem RPCs are driven through the environment atoms (the old imperative
  // `readEnvironmentApi().filesystem.*` accessor was removed). Reads run via a
  // query runner; the write goes through the command atom and re-resolves the file.
  const readWorkspaceFile = useAtomQueryRunner(filesystemEnvironment.readWorkspaceFile, {
    reportFailure: false,
  });
  const writeWorkspaceFile = useAtomCommand(filesystemEnvironment.writeWorkspaceFile, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  });

  const load = useCallback(async () => {
    if (!workspaceFile || !environmentId) {
      return;
    }
    setStatus("loading");
    setErrorMessage(null);
    const result = await readWorkspaceFile({
      environmentId,
      input: { workspaceFilePath: workspaceFile },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to read the workspace file.",
      );
      return;
    }
    setFolders(result.value.folders.map(rowFromResolved));
    setStatus("ready");
  }, [environmentId, readWorkspaceFile, workspaceFile]);

  // Re-read the `.code-workspace` from disk every time the dialog opens, so an
  // edit made in VS Code (or a moved folder) is reflected without a reload.
  useEffect(() => {
    if (target === null) {
      return;
    }
    void load();
  }, [target, load]);

  const removeFolder = useCallback((key: string) => {
    setFolders((current) => current.filter((folder) => folder.key !== key));
  }, []);

  const addFolder = useCallback(async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "warning",
        title: "Folder picker unavailable in this environment.",
      });
      return;
    }
    setAdding(true);
    let picked: string | null = null;
    try {
      picked = await api.dialogs.pickFolder();
    } catch {
      setAdding(false);
      return;
    }
    setAdding(false);
    if (!picked) {
      return;
    }
    setFolders((current) => {
      if (current.some((folder) => folder.absolutePath === picked)) {
        return current;
      }
      return [
        ...current,
        {
          key: picked,
          path: picked,
          name: undefined,
          absolutePath: picked,
          exists: true,
          isGit: false,
          isNew: true,
        },
      ];
    });
  }, []);

  const save = useCallback(async () => {
    if (!target || !workspaceFile) {
      return;
    }
    if (folders.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Keep at least one folder",
        description: "A workspace needs at least one folder.",
      });
      return;
    }
    setSaving(true);
    try {
      const writeResult = await writeWorkspaceFile({
        environmentId: target.environmentId,
        input: {
          workspaceFilePath: workspaceFile,
          folders: folders.map((folder) =>
            folder.name === undefined
              ? { path: folder.path }
              : { path: folder.path, name: folder.name },
          ),
        },
      });
      if (writeResult._tag === "Failure") {
        const error = squashAtomCommandFailure(writeResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to update folders",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const resolved = writeResult.value;
      // Reconcile the project's persisted roots/identity with the freshly
      // resolved file. The server re-resolves identity on meta.update.
      await updateProject({
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          workspaceFile: resolved.workspaceFilePath,
          repoRoots: resolved.repoRoots,
        },
      });
      const missing = resolved.folders.filter((folder) => !folder.exists);
      if (missing.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some folders are missing",
          description: `${missing.map((folder) => folder.name).join(", ")} could not be found on disk.`,
        });
      } else {
        toastManager.add({ type: "success", title: "Workspace folders updated" });
      }
      onClose();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update folders",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [folders, onClose, target, updateProject, workspaceFile, writeWorkspaceFile]);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Workspace folders</DialogTitle>
          <DialogDescription>
            {workspaceFile
              ? `Add or remove folders in ${basename(workspaceFile)}. Changes are written back to the file.`
              : "Manage the folders that make up this workspace."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {status === "loading" ? (
            <p className="text-xs text-muted-foreground">Reading workspace file…</p>
          ) : status === "error" ? (
            <div className="space-y-2">
              <p className="text-xs text-destructive">{errorMessage}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              <ul className="space-y-1.5">
                {folders.map((folder) => (
                  <li
                    key={folder.key}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {folder.name ?? basename(folder.absolutePath)}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {folder.absolutePath}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <FolderBadge folder={folder} />
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${folder.name ?? basename(folder.absolutePath)}`}
                        onClick={() => removeFolder(folder.key)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {folders.length === 0 ? (
                <p className="text-xs text-muted-foreground">No folders in this workspace.</p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={adding}
                  onClick={() => void addFolder()}
                >
                  {adding ? "Choosing…" : "Add folder…"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void load()}>
                  Re-read from disk
                </Button>
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || status !== "ready"} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function FolderBadge({ folder }: { readonly folder: FolderRow }): React.ReactNode {
  if (folder.isNew) {
    return <span className="text-xs text-muted-foreground">new</span>;
  }
  if (!folder.exists) {
    return <span className="text-xs font-medium text-destructive">missing</span>;
  }
  return <span className="text-xs text-muted-foreground">{folder.isGit ? "git" : "non-git"}</span>;
}

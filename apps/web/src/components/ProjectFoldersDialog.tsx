import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useId, useState } from "react";

import { projectEnvironment } from "../state/projects";
import { filesystemEnvironment } from "../state/filesystem";
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
import { Input } from "./ui/input";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface ProjectFoldersDialogTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The first repository: provider cwd, Git-action target, and settings root. */
  readonly workspaceRoot: string;
  readonly repoRoots?: ReadonlyArray<string>;
  /** Retained as import/editor metadata; T3 owns the persisted repository list. */
  readonly workspaceFile?: string;
}

function basename(input: string): string {
  const segments = input.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? input;
}

function projectRoots(target: ProjectFoldersDialogTarget): string[] {
  const candidates = [target.workspaceRoot, ...(target.repoRoots ?? [])];
  const seen = new Set<string>();
  return candidates.filter((path) => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

export function ProjectFoldersDialog({
  target,
  onClose,
}: {
  readonly target: ProjectFoldersDialogTarget | null;
  readonly onClose: () => void;
}): React.ReactNode {
  const inputId = useId();
  const [roots, setRoots] = useState<string[]>([]);
  const [newRoot, setNewRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const isBusy = saving || validating;
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const scanGitRepos = useAtomQueryRunner(filesystemEnvironment.scanGitRepos, {
    reportFailure: false,
  });

  useEffect(() => {
    if (!target) return;
    setRoots(projectRoots(target));
    setNewRoot("");
  }, [target]);

  const addRoot = useCallback(async () => {
    if (!target) return;
    const path = newRoot.trim();
    if (!path) return;
    setValidating(true);
    const result = await scanGitRepos({
      environmentId: target.environmentId,
      input: { parentPath: path },
    });
    setValidating(false);
    if (result._tag === "Failure" || !result.value.parentHasGit) {
      const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Choose a Git repository",
          description: error instanceof Error ? error.message : `${path} is not a Git repository.`,
        }),
      );
      return;
    }
    const normalizedPath = result.value.parentPath;
    setRoots((current) =>
      current.includes(normalizedPath) ? current : [...current, normalizedPath],
    );
    setNewRoot("");
  }, [newRoot, scanGitRepos, target]);

  const makePrimary = useCallback((path: string) => {
    setRoots((current) => [path, ...current.filter((candidate) => candidate !== path)]);
  }, []);

  const removeRoot = useCallback((path: string) => {
    setRoots((current) => current.filter((candidate) => candidate !== path));
  }, []);

  const save = useCallback(async () => {
    if (!target) return;
    if (roots.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Keep at least one repository",
        description: "Every project needs a primary repository.",
      });
      return;
    }

    setSaving(true);
    try {
      const result = await updateProject({
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          workspaceRoot: roots[0]!,
          repoRoots: roots,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to update repositories",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      toastManager.add({ type: "success", title: "Project repositories updated" });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [onClose, roots, target, updateProject]);

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !isBusy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {target ? `${target.title} repositories` : "Project repositories"}
          </DialogTitle>
          <DialogDescription>
            The primary repository is the default working directory and Git target. Agents can read
            and edit every attached repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ul className="space-y-1.5">
            {roots.map((root, index) => (
              <li
                key={root}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {basename(root)}
                    </span>
                    {index === 0 ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Primary
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{root}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {index > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isBusy}
                      onClick={() => makePrimary(root)}
                    >
                      Make primary
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isBusy || roots.length === 1}
                    aria-label={`Remove ${basename(root)}`}
                    onClick={() => removeRoot(root)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          <form
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void addRoot();
            }}
          >
            <label htmlFor={inputId} className="text-xs font-medium text-foreground">
              Repository path
            </label>
            <div className="flex gap-2">
              <Input
                id={inputId}
                value={newRoot}
                placeholder="/absolute/path/to/repository"
                aria-label="Repository path"
                disabled={isBusy}
                onChange={(event) => setNewRoot(event.currentTarget.value)}
              />
              <Button
                type="submit"
                variant="outline"
                disabled={isBusy || newRoot.trim().length === 0}
              >
                {validating ? "Checking…" : "Add"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use a path on this project's environment. Attached paths are available to local and
              remote clients.
            </p>
            {target?.workspaceFile ? (
              <p className="text-xs text-muted-foreground">
                Imported from {basename(target.workspaceFile)}. Future repository changes are saved
                in T3 Code and do not rewrite that file.
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={isBusy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={isBusy || roots.length === 0} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

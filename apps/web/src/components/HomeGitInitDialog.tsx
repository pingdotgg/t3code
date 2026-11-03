import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { threadRepositoriesTarget } from "@t3tools/client-runtime/state/thread-repositories";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { WorkspaceHomeGitInitPreview } from "@t3tools/contracts";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { workspaceRepositoryEnvironment } from "../state/workspaceRepositories";
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
import { Label } from "./ui/label";
import { stackedThreadToast, toastManager } from "./ui/toast";

type HomeGitProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot" | "trackedFolders"
>;

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/**
 * "Initialize Git and commit home files" for a plain home folder with tracked repos: worktrees
 * need a Git home. `start` loads the preview first, so the confirm shows exactly what commits.
 */
export function useHomeGitInit(project: HomeGitProject | null, onInitialized?: () => void) {
  const canInitialize = useAtomValue(
    workspaceRepositoryEnvironment.initializeHomeGit.permissionAtom(project?.environmentId ?? null),
  );
  const previewHomeGitInit = useAtomCommand(workspaceRepositoryEnvironment.previewHomeGitInit, {
    reportFailure: false,
  });
  const [preview, setPreview] = useState<WorkspaceHomeGitInitPreview | null>(null);
  const [loading, setLoading] = useState(false);

  const start = async () => {
    if (project === null || loading) return;
    setLoading(true);
    const result = await previewHomeGitInit({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    });
    setLoading(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not prepare the first commit",
            description: errorMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    setPreview(result.value);
  };

  const dialog =
    project !== null && preview !== null ? (
      <HomeGitInitDialog
        project={project}
        preview={preview}
        onClose={() => setPreview(null)}
        {...(onInitialized ? { onInitialized } : {})}
      />
    ) : null;

  return { canInitialize: project !== null && canInitialize, loading, start, dialog };
}

function HomeGitInitDialog({
  project,
  preview,
  onClose,
  onInitialized,
}: {
  project: HomeGitProject;
  preview: WorkspaceHomeGitInitPreview;
  onClose: () => void;
  onInitialized?: () => void;
}) {
  const initializeHomeGit = useAtomCommand(workspaceRepositoryEnvironment.initializeHomeGit, {
    reportFailure: false,
  });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hiddenFileCount = preview.fileCount - preview.files.length;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await initializeHomeGit({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    });
    if (result._tag === "Failure") {
      setSubmitting(false);
      if (!isAtomCommandInterrupted(result))
        setError(errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    // The composer reads Git-ness from the status stream and the repo list; both changed.
    await refreshStatus({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    });
    const target = threadRepositoriesTarget({
      environmentId: project.environmentId,
      project,
      worktreePath: null,
    });
    if (target !== null) {
      appAtomRegistry.refresh(workspaceRepositoryEnvironment.repositories(target));
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Committed ${result.value.fileCount} ${result.value.fileCount === 1 ? "file" : "files"}`,
        description: project.workspaceRoot,
      }),
    );
    onClose();
    onInitialized?.();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Initialize Git and commit home files</DialogTitle>
          <DialogDescription>
            New worktrees need {project.title} to be a Git repo. This runs git init in{" "}
            <span className="font-mono">{project.workspaceRoot}</span> and makes a first commit.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1.5">
            <Label>
              First commit · {preview.fileCount} {preview.fileCount === 1 ? "file" : "files"}
            </Label>
            <div className="max-h-52 overflow-y-auto rounded-md border px-2.5 py-1.5 font-mono text-xs">
              {preview.files.map((file) => (
                <div key={file} className="truncate">
                  {file}
                </div>
              ))}
              {hiddenFileCount > 0 ? (
                <div className="text-muted-foreground">and {hiddenFileCount} more</div>
              ) : null}
            </div>
          </div>
          {preview.ignoreEntries.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label>.gitignore</Label>
              <div className="rounded-md border px-2.5 py-1.5 font-mono text-xs">
                {preview.ignoreEntries.map((entry) => (
                  <div key={entry} className="truncate">
                    {entry}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? "Committing…" : "Initialize and commit"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { findExistingAddProject } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ThreadCheckpointOutsideEdit } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  describeOutsideEdit,
  OUTSIDE_EDITS_SHELL_NOTE,
} from "@t3tools/client-runtime/state/thread-repositories";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { newProjectId } from "../../lib/utils";
import { readProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
  return true;
}

/**
 * Repos a run edited without a checkpoint: untracked ones can join the project or open as their
 * own project, tracked ones open their uncommitted changes.
 */
export function OutsideEditsNotice(props: {
  readonly edits: ReadonlyArray<ThreadCheckpointOutsideEdit>;
  readonly project: EnvironmentProject | null;
  /** Unset where there is no diff panel to open. */
  readonly onReview: ((edit: ThreadCheckpointOutsideEdit) => void) | undefined;
}) {
  const { edits, project } = props;
  const environmentId = project?.environmentId ?? null;
  const canChangeProjects = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const createProject = useOrchestrationCommand(projectEnvironment.create, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const [busyRoot, setBusyRoot] = useState<string | null>(null);

  const track = async (edit: ThreadCheckpointOutsideEdit) => {
    if (project === null) return;
    setBusyRoot(edit.root);
    const result = await updateProject({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        trackedFolders: [...project.trackedFolders, { path: edit.root, name: edit.name }],
      },
    });
    setBusyRoot(null);
    reportFailure(`Could not track ${edit.name}`, result);
  };

  const openAsProject = async (edit: ThreadCheckpointOutsideEdit) => {
    if (environmentId === null) return;
    const existing = findExistingAddProject({
      projects: readProjects(),
      environmentId,
      path: edit.root,
    });
    const projectId = existing?.id ?? newProjectId();
    if (existing === null) {
      setBusyRoot(edit.root);
      const result = await createProject({
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(edit.root),
          workspaceRoot: edit.root,
          defaultModelSelection: null,
        },
      });
      setBusyRoot(null);
      if (reportFailure(`Could not open ${edit.name} as a project`, result)) return;
    }
    reportFailure(
      `Could not open ${edit.name} as a project`,
      await settlePromise(() => handleNewThread(scopeProjectRef(environmentId, projectId))),
    );
  };
  // The recorded edit keeps its old flag, so a folder tracked since then shows Review.
  const trackedRoots = new Set(
    project?.trackedFolders.map((folder) => normalizeProjectPathForComparison(folder.path)),
  );

  return (
    <div className="mt-2 flex flex-col gap-1 px-1 text-xs text-muted-foreground">
      {edits.map((recorded) => {
        const edit = trackedRoots.has(normalizeProjectPathForComparison(recorded.root))
          ? { ...recorded, tracked: true }
          : recorded;
        return (
          <div key={edit.root} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 wrap-break-word">{describeOutsideEdit(edit)}</span>
            {edit.tracked ? (
              props.onReview === undefined ? null : (
                <Button size="xs" variant="ghost-muted" onClick={() => props.onReview?.(edit)}>
                  Review
                </Button>
              )
            ) : canChangeProjects ? (
              <>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busyRoot === edit.root || project === null}
                  onClick={() => void track(edit)}
                >
                  Track
                </Button>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={busyRoot === edit.root}
                  onClick={() => void openAsProject(edit)}
                >
                  Open as project
                </Button>
              </>
            ) : null}
          </div>
        );
      })}
      <p className="text-muted-foreground/70">{OUTSIDE_EDITS_SHELL_NOTE}</p>
    </div>
  );
}

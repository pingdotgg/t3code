import { getBrowseParentPath } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ProjectTrackedFolder } from "@t3tools/contracts";
import { useState } from "react";

import {
  addTrackedFolder,
  relocateTrackedFolder,
  removeTrackedFolder,
  scannedFoldersTitle,
  trackedFolderState,
  trackedGitRepositories,
  untrackedScannedFolders,
} from "../../lib/multiRepo";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { useWorkspaceRepositories } from "../../state/threadRepositories";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { workspaceRepositoryEnvironment } from "../../state/workspaceRepositories";
import { INITIALIZE_HOME_GIT_LABEL } from "../BranchToolbarEnvModeSelector";
import { useHomeGitInit } from "../HomeGitInitDialog";
import { chooseTrackedFolders } from "../TrackedFoldersDialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ServerFolderPickerDialog } from "./ServerFolderPickerDialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Picker = { readonly mode: "add" } | { readonly mode: "locate"; readonly path: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "An error occurred.";
}

/** The folders a project tracks besides home. Paths belong to `project`'s machine. */
export function ProjectRepositoriesSettings({
  project,
  title,
  canEdit,
}: {
  project: SidebarProjectGroupMember;
  title: string;
  canEdit: boolean;
}) {
  const workspace = useWorkspaceRepositories({
    environmentId: project.environmentId,
    project,
    worktreePath: null,
  });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const scanFolders = useAtomCommand(workspaceRepositoryEnvironment.scanFolders, {
    reportFailure: false,
  });
  const homeGitInit = useHomeGitInit(project);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [busy, setBusy] = useState(false);
  const homeIsGitRepository =
    workspace?.repositories.some((repository) => repository.kind === "home") ?? true;

  const save = async (trackedFolders: ProjectTrackedFolder[], failureTitle: string) => {
    setBusy(true);
    const result = await updateProject({
      environmentId: project.environmentId,
      input: { projectId: project.id, trackedFolders },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: errorMessage(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  const rescan = async () => {
    setBusy(true);
    const result = await scanFolders({
      environmentId: project.environmentId,
      input: { workspaceRoot: project.workspaceRoot },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not scan the project",
            description: errorMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return;
    }
    const folders = untrackedScannedFolders(project.trackedFolders, result.value.folders);
    if (folders.length === 0) {
      toastManager.add({ type: "info", title: "No new folders found" });
      return;
    }
    const chosen = await chooseTrackedFolders({
      title: `${scannedFoldersTitle(folders)} not tracked yet`,
      submitLabel: "Track",
      workspaceRoot: project.workspaceRoot,
      scan: { ...result.value, folders },
    });
    if (chosen === null || chosen.length === 0) return;
    await save([...project.trackedFolders, ...chosen], "Could not track the folders");
  };

  const pick = (path: string) => {
    if (picker === null) return;
    setPicker(null);
    void (picker.mode === "add"
      ? save(addTrackedFolder(project.trackedFolders, path), "Could not add the folder")
      : save(
          relocateTrackedFolder(project.trackedFolders, picker.path, path),
          "Could not move the folder",
        ));
  };

  const disabled = !canEdit || busy;
  return (
    <>
      <SettingsSection
        title={title}
        headerAction={
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void rescan()}>
              Rescan
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => setPicker({ mode: "add" })}
            >
              Add
            </Button>
          </div>
        }
      >
        {project.trackedFolders.length === 0 ? (
          <SettingsRow
            title="Home folder only"
            description="Add repos that live next to or inside this project to work across them."
          />
        ) : null}
        {project.trackedFolders.map((folder) => {
          const state = trackedFolderState(folder, workspace);
          const label = state.missing ? "Missing" : state.kind === "reference" ? "Reference" : null;
          return (
            <SettingsRow
              key={folder.path}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{folder.name}</span>
                  {label ? (
                    <span className="shrink-0 font-normal text-muted-foreground text-xs">
                      {label}
                    </span>
                  ) : null}
                </span>
              }
              description={<span className="block truncate font-mono">{folder.path}</span>}
              control={
                <div className="flex items-center gap-1.5">
                  {state.missing ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => setPicker({ mode: "locate", path: folder.path })}
                    >
                      Locate
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`Remove ${folder.name}`}
                    onClick={() =>
                      void save(
                        removeTrackedFolder(project.trackedFolders, folder.path),
                        "Could not remove the folder",
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              }
            />
          );
        })}
        {!homeIsGitRepository && trackedGitRepositories(workspace).length > 0 ? (
          <SettingsRow
            title="Home folder is not a Git repo"
            description="New worktrees need it to be one."
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={!homeGitInit.canInitialize || homeGitInit.loading}
                onClick={() => void homeGitInit.start()}
              >
                {INITIALIZE_HOME_GIT_LABEL}
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      {picker ? (
        <ServerFolderPickerDialog
          environmentId={project.environmentId}
          title={picker.mode === "add" ? "Track a folder" : "Locate folder"}
          submitLabel={picker.mode === "add" ? "Track" : "Use this folder"}
          initialPath={
            getBrowseParentPath(picker.mode === "add" ? project.workspaceRoot : picker.path) ??
            project.workspaceRoot
          }
          onPick={pick}
          onClose={() => setPicker(null)}
        />
      ) : null}
      {homeGitInit.dialog}
    </>
  );
}

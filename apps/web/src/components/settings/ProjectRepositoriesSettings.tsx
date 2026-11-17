import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  getBrowseParentPath,
  suggestedTrackedFolders,
} from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  PROJECT_TRACKED_FOLDERS_MAX,
  type EnvironmentId,
  type ProjectTrackedFolder,
  type WorkspaceFolderState,
} from "@t3tools/contracts";
import { FolderIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { checkProjectAccess, reportProjectFailure } from "../../hooks/useProjectGroupUpdate";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import { resolveTrackedFolderInput, trackedFolderDisplayPath } from "./trackedFolders.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NO_TRACKED_FOLDERS: ReadonlyArray<ProjectTrackedFolder> = [];
const BROWSE_SUGGESTION_LIMIT = 100;

const FOLDER_STATE_LABELS: Record<WorkspaceFolderState, string> = {
  git: "Git repository",
  plain: "Folder",
  missing: "Missing",
};

/** Tracked folder paths belong to one checkout's machine, so each checkout has its own list. */
export function ProjectRepositoriesSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  if (checkouts.length === 0) return null;
  return (
    <SettingsSection id="project-repositories" title="Repositories">
      {checkouts.map((member) => (
        <CheckoutRepositories key={member.physicalProjectKey} member={member} />
      ))}
    </SettingsSection>
  );
}

function CheckoutRepositories({ member }: { member: SidebarProjectGroupMember }) {
  const environmentId = member.environmentId;
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const isConnected = environment?.connection.phase === "connected";
  const canEdit = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const access = useFilesystemReadAccess(environmentId);
  const tracked = member.trackedFolders ?? NO_TRACKED_FOLDERS;
  // Read from disk: the project's own copy of the list can be a moment behind a clone.
  const listQuery = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.listFolders({ environmentId, input: { projectId: member.id } })
      : null,
  );
  const folders: ReadonlyArray<ProjectTrackedFolder & { state?: WorkspaceFolderState }> =
    listQuery.data?.folders ?? tracked;
  // Only a workspace file's folders are offered: the rest is found without asking.
  const scanQuery = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.scanFolders({
          environmentId,
          input: { workspaceRoot: member.workspaceRoot },
        })
      : null,
  );
  const suggested = suggestedTrackedFolders(folders, scanQuery.data?.folders ?? []);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const disabled = !canEdit || !isConnected || isSaving;
  const added = folders.filter((folder) => folder.discovered !== true);

  const save = async (next: ReadonlyArray<ProjectTrackedFolder>, failureTitle: string) => {
    if (checkProjectAccess([member], failureTitle)) return false;
    setIsSaving(true);
    const result = await updateProject({
      environmentId,
      input: {
        projectId: member.id,
        trackedFolders: next.map(({ path, name }) => ({ path, name })),
      },
    });
    setIsSaving(false);
    if (result._tag === "Failure") {
      reportProjectFailure(failureTitle, result);
      return false;
    }
    listQuery.refresh();
    return true;
  };

  const addFolder = async (folder: ProjectTrackedFolder) => {
    if (await save([...added, folder], "Failed to add folder")) setIsAddingFolder(false);
  };

  return (
    <>
      <SettingsRow
        title={member.environmentLabel ?? "Environment"}
        description={member.workspaceRoot}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || folders.length >= PROJECT_TRACKED_FOLDERS_MAX}
            onClick={() => setIsAddingFolder(true)}
          >
            <PlusIcon className="size-3.5" />
            Add folder
          </Button>
        }
      />
      {folders.length === 0 ? (
        <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
          Repositories inside this folder are part of the project as soon as they are there. Add a
          folder to bring in one from somewhere else.
        </p>
      ) : (
        folders.map((folder) => (
          <SettingsRow
            key={folder.path}
            className="py-2"
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{folder.name}</span>
                {folder.state ? (
                  <Badge size="sm" variant={folder.state === "missing" ? "warning" : "outline"}>
                    {FOLDER_STATE_LABELS[folder.state]}
                  </Badge>
                ) : null}
              </span>
            }
            description={
              <code className="block max-w-full truncate font-mono">
                {trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
              </code>
            }
            control={
              // A repository inside the project folder is there for as long as it is on disk.
              folder.discovered === true ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Remove ${folder.name} from the project`}
                  onClick={() =>
                    void save(
                      added.filter((candidate) => candidate.path !== folder.path),
                      "Failed to remove folder",
                    )
                  }
                >
                  Remove
                </Button>
              )
            }
          />
        ))
      )}
      {suggested.map((folder) => (
        <SettingsRow
          key={folder.path}
          className="py-2"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate text-muted-foreground">{folder.name}</span>
              <Badge size="sm" variant="outline">
                In workspace file
              </Badge>
            </span>
          }
          description={
            <code className="block max-w-full truncate font-mono">
              {trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
            </code>
          }
          control={
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-label={`Add ${folder.name} to the project`}
              onClick={() => void save([...added, folder], "Failed to add folder")}
            >
              Add
            </Button>
          }
        />
      ))}
      {listQuery.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-warning-foreground sm:px-4">
          {listQuery.error}
        </p>
      ) : null}
      {isAddingFolder ? (
        <AddTrackedFolderDialog
          environmentId={environmentId}
          workspaceRoot={member.workspaceRoot}
          platform={getEnvironmentBrowsePlatform(
            environment?.serverConfig?.environment.platform.os,
          )}
          canBrowse={access.canReadFiles}
          busy={isSaving}
          onAdd={(folder) => void addFolder(folder)}
          onClose={() => setIsAddingFolder(false)}
        />
      ) : null}
    </>
  );
}

function AddTrackedFolderDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly platform: string;
  readonly canBrowse: boolean;
  readonly busy: boolean;
  readonly onAdd: (folder: ProjectTrackedFolder) => void;
  readonly onClose: () => void;
}) {
  const inputId = useId();
  // Repositories next to the project folder are the common case, so the listing starts there.
  const [query, setQuery] = useState(
    () =>
      getBrowseParentPath(props.workspaceRoot) ?? ensureBrowseDirectoryPath(props.workspaceRoot),
  );
  const browsePath = getFilesystemBrowsePath(query, props.platform, props.canBrowse);
  const browseQuery = useEnvironmentQuery(
    browsePath.isBrowsing && browsePath.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: browsePath.directoryPath, cwd: props.workspaceRoot },
        })
      : null,
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    browseQuery.data?.entries ?? [],
    browsePath.filterQuery,
  );
  const folder = resolveTrackedFolderInput({
    query,
    listedDirectoryPath: browseQuery.data?.parentPath ?? null,
    exactEntryPath: exactEntry?.fullPath ?? null,
  });
  const parentPath = browsePath.canBrowseUp ? browsePath.parentPath : null;
  const hiddenCount = Math.max(0, visibleEntries.length - BROWSE_SUGGESTION_LIMIT);
  const rowClassName =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (folder && !props.busy) props.onAdd(folder);
          }}
        >
          <DialogHeader>
            <DialogTitle>Add folder</DialogTitle>
            <DialogDescription>
              Track a repository or folder anywhere on this project's machine.
            </DialogDescription>
            <div className="flex flex-col gap-2 pt-1">
              <Label htmlFor={inputId}>Folder path</Label>
              <Input
                id={inputId}
                font="mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="/path/to/repository"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
          </DialogHeader>
          <DialogPanel>
            <div className="-mx-2 flex min-h-40 flex-col">
              {parentPath !== null ? (
                <button type="button" className={rowClassName} onClick={() => setQuery(parentPath)}>
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  ..
                </button>
              ) : null}
              {visibleEntries.slice(0, BROWSE_SUGGESTION_LIMIT).map((entry) => (
                <button
                  key={entry.fullPath}
                  type="button"
                  className={rowClassName}
                  onClick={() => setQuery(appendBrowsePathSegment(query, entry.name))}
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
              ))}
              {browseQuery.error ? (
                <p role="alert" className="px-2 py-1.5 text-sm text-muted-foreground">
                  {browseQuery.error}
                </p>
              ) : browseQuery.isPending && browseQuery.data === null ? (
                <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
                  Loading folders…
                </p>
              ) : hiddenCount > 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {hiddenCount} more. Keep typing to narrow the list.
                </p>
              ) : !props.canBrowse ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  This connection cannot browse folders. Enter an absolute path.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={folder === null || props.busy}>
              Add folder
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

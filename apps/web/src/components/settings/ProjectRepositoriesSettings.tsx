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
import { msg, T, useGT, useMessages, Var } from "gt-react";
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
  git: msg("Git repository"),
  plain: msg("Folder", { $context: "a plain folder that is not a Git repository" }),
  missing: msg("Missing", { $context: "folder state: not found on disk" }),
};

/** Tracked folder paths belong to one checkout's machine, so each checkout has its own list. */
export function ProjectRepositoriesSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  const gt = useGT();
  if (checkouts.length === 0) return null;
  return (
    <SettingsSection id="project-repositories" title={gt("Repositories")}>
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
  // A save builds on the listed folders, so it waits for the list that follows the last one.
  const disabled = !canEdit || !isConnected || isSaving || listQuery.isPending;
  const gt = useGT();
  const m = useMessages();

  // One folder in or out: the server applies it to its own list, which another client may have
  // changed since this one was read.
  const save = async (
    change: { readonly track: ProjectTrackedFolder } | { readonly untrack: string },
    failureTitle: string,
  ) => {
    if (checkProjectAccess([member], failureTitle)) return false;
    setIsSaving(true);
    const result = await updateProject({
      environmentId,
      input: {
        projectId: member.id,
        ...("track" in change
          ? { trackFolders: [{ path: change.track.path, name: change.track.name }] }
          : { untrackFolders: [change.untrack] }),
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
    if (await save({ track: folder }, gt("Failed to add folder"))) setIsAddingFolder(false);
  };

  return (
    <>
      <SettingsRow
        title={member.environmentLabel ?? gt("Environment")}
        description={member.workspaceRoot}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || folders.length >= PROJECT_TRACKED_FOLDERS_MAX}
            onClick={() => setIsAddingFolder(true)}
          >
            <PlusIcon className="size-3.5" />
            <T>Add folder</T>
          </Button>
        }
      />
      {folders.length === 0 ? (
        <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
          <T>
            Repositories inside this folder are part of the project as soon as they are there. Add a
            folder to bring in one from somewhere else.
          </T>
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
                    {m(FOLDER_STATE_LABELS[folder.state])}
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
                  aria-label={gt("Remove {name} from the project", { name: folder.name })}
                  onClick={() => void save({ untrack: folder.path }, gt("Failed to remove folder"))}
                >
                  <T>Remove</T>
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
                <T>In workspace file</T>
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
              aria-label={gt("Add {name} to the project", { name: folder.name })}
              onClick={() => void save({ track: folder }, gt("Failed to add folder"))}
            >
              <T>Add</T>
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
          busy={isSaving || listQuery.isPending}
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
            <DialogTitle>
              <T>Add folder</T>
            </DialogTitle>
            <DialogDescription>
              <T>Track a repository or folder anywhere on this project's machine.</T>
            </DialogDescription>
            <div className="flex flex-col gap-2 pt-1">
              <Label htmlFor={inputId}>
                <T>Folder path</T>
              </Label>
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
                  onClick={() =>
                    setQuery(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
                  }
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
                  <T>Loading folders…</T>
                </p>
              ) : hiddenCount > 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  <T>
                    <Var>{hiddenCount}</Var> more. Keep typing to narrow the list.
                  </T>
                </p>
              ) : !props.canBrowse ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  <T>This connection cannot browse folders. Enter an absolute path.</T>
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={folder === null || props.busy}>
              <T>Add folder</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

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
import { fileDisplayName } from "@t3tools/shared/path";
import { FolderGit2Icon, FolderIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { checkProjectAccess, reportProjectFailure } from "../../hooks/useProjectGroupUpdate";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import { resolveTrackedFolderInput, trackedFolderDisplayPath } from "./trackedFolders.logic";
import { Badge } from "../ui/badge";
import { Button, ContentButton } from "../ui/button";
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
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsNote, SettingsRow, SettingsSection } from "./settingsLayout";

const NO_TRACKED_FOLDERS: ReadonlyArray<ProjectTrackedFolder> = [];
const BROWSE_SUGGESTION_LIMIT = 100;

const FOLDER_STATE_LABELS: Record<WorkspaceFolderState, string> = {
  git: msg("Git repository"),
  plain: msg("Folder", { $context: "a plain folder that is not a Git repository" }),
  missing: msg("Missing", { $context: "folder state: not found on disk" }),
};

function PathWithTooltip({ display, fullPath }: { display: string; fullPath: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block truncate font-mono" tabIndex={0} />}>
        {display}
      </TooltipTrigger>
      <TooltipPopup>{fullPath}</TooltipPopup>
    </Tooltip>
  );
}

function FolderErrorIndicator({ message }: { message: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="alert"
            tabIndex={0}
            aria-label={message}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-badge text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <TriangleAlertIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{message}</TooltipPopup>
    </Tooltip>
  );
}

function SingleCheckoutAddButton({
  member,
  isSaving,
  onOpen,
}: {
  member: SidebarProjectGroupMember;
  isSaving: boolean;
  onOpen: () => void;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === member.environmentId);
  const isConnected = environment?.connection.phase === "connected";
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const access = useFilesystemReadAccess(member.environmentId);
  const tracked = member.trackedFolders ?? NO_TRACKED_FOLDERS;
  const listQuery = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.listFolders({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        })
      : null,
  );
  const folders = listQuery.data?.folders ?? tracked;
  const disabled =
    !canEdit ||
    !isConnected ||
    isSaving ||
    listQuery.isPending ||
    folders.length >= PROJECT_TRACKED_FOLDERS_MAX;

  return (
    <Button size="xs" variant="secondary" disabled={disabled} onClick={onOpen}>
      <PlusIcon />
      <T>Add folder</T>
    </Button>
  );
}

function MultiCheckoutAddMenuItem({
  member,
  spansEnvironments,
  isSaving,
  onSelect,
}: {
  member: SidebarProjectGroupMember;
  spansEnvironments: boolean;
  isSaving: boolean;
  onSelect: () => void;
}) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === member.environmentId);
  const isConnected = environment?.connection.phase === "connected";
  const canEdit = useEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope);
  const access = useFilesystemReadAccess(member.environmentId);
  const tracked = member.trackedFolders ?? NO_TRACKED_FOLDERS;
  const listQuery = useEnvironmentQuery(
    access.canReadFiles
      ? filesystemEnvironment.listFolders({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        })
      : null,
  );
  const folders = listQuery.data?.folders ?? tracked;
  const disabled =
    !canEdit ||
    !isConnected ||
    isSaving ||
    listQuery.isPending ||
    folders.length >= PROJECT_TRACKED_FOLDERS_MAX;
  const folderName = fileDisplayName(member.workspaceRoot);

  return (
    <MenuItem disabled={disabled} onClick={onSelect}>
      <FolderIcon className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-label">{folderName}</span>
          {spansEnvironments ? (
            <span className="shrink-0 text-meta text-muted-foreground">
              {member.environmentLabel ?? gt("Environment")}
            </span>
          ) : null}
        </div>
        <div className="truncate font-mono text-meta text-muted-foreground">
          {member.workspaceRoot}
        </div>
      </div>
    </MenuItem>
  );
}

function MultiCheckoutAddMenu({
  checkouts,
  spansEnvironments,
  savingMemberKey,
  onSelect,
}: {
  checkouts: ReadonlyArray<SidebarProjectGroupMember>;
  spansEnvironments: boolean;
  savingMemberKey: string | null;
  onSelect: (memberKey: string) => void;
}) {
  const { environments } = useEnvironments();
  const editableIds = useEnvironmentsWithScope(checkouts, AuthOrchestrationOperateScope);
  const anyAvailable = checkouts.some((member) => {
    const environment = environments.find((entry) => entry.environmentId === member.environmentId);
    return (
      editableIds.has(member.environmentId) &&
      environment?.connection.phase === "connected" &&
      savingMemberKey !== member.physicalProjectKey
    );
  });

  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="secondary" disabled={!anyAvailable} type="button" />}
      >
        <PlusIcon />
        <T>Add folder</T>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>
            <T>Add folder</T>
          </MenuGroupLabel>
          {checkouts.map((member) => (
            <MultiCheckoutAddMenuItem
              key={member.physicalProjectKey}
              member={member}
              spansEnvironments={spansEnvironments}
              isSaving={savingMemberKey === member.physicalProjectKey}
              onSelect={() => onSelect(member.physicalProjectKey)}
            />
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** Tracked folder paths belong to one checkout's machine, so each checkout has its own list. */
export function ProjectRepositoriesSettings({
  members,
}: {
  members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const checkouts = members.filter((member) => !member.isScratch);
  const gt = useGT();
  const [addingMemberKey, setAddingMemberKey] = useState<string | null>(null);
  const [savingMemberKey, setSavingMemberKey] = useState<string | null>(null);
  if (checkouts.length === 0) return null;
  const spansEnvironments = new Set(checkouts.map((member) => member.environmentId)).size > 1;
  const onlyCheckout = checkouts.length === 1 ? checkouts[0]! : null;

  return (
    <SettingsSection
      id="project-repositories"
      title={gt("Repositories")}
      headerAction={
        onlyCheckout ? (
          <SingleCheckoutAddButton
            member={onlyCheckout}
            isSaving={savingMemberKey === onlyCheckout.physicalProjectKey}
            onOpen={() => setAddingMemberKey(onlyCheckout.physicalProjectKey)}
          />
        ) : (
          <MultiCheckoutAddMenu
            checkouts={checkouts}
            spansEnvironments={spansEnvironments}
            savingMemberKey={savingMemberKey}
            onSelect={setAddingMemberKey}
          />
        )
      }
    >
      <SettingsNote>
        <T>
          Repositories inside this folder are part of the project as soon as they are there. Add a
          folder to bring in one from somewhere else.
        </T>
      </SettingsNote>
      {checkouts.map((member) => (
        <CheckoutRepositories
          key={member.physicalProjectKey}
          member={member}
          spansEnvironments={spansEnvironments}
          isAdding={addingMemberKey === member.physicalProjectKey}
          isSaving={savingMemberKey === member.physicalProjectKey}
          onSavingChange={(saving) => setSavingMemberKey(saving ? member.physicalProjectKey : null)}
          onCloseAdd={() => setAddingMemberKey(null)}
        />
      ))}
    </SettingsSection>
  );
}

function CheckoutRepositories({
  member,
  spansEnvironments,
  isAdding,
  isSaving,
  onSavingChange,
  onCloseAdd,
}: {
  member: SidebarProjectGroupMember;
  spansEnvironments: boolean;
  isAdding: boolean;
  isSaving: boolean;
  onSavingChange: (saving: boolean) => void;
  onCloseAdd: () => void;
}) {
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
    onSavingChange(true);
    const result = await updateProject({
      environmentId,
      input: {
        projectId: member.id,
        ...("track" in change
          ? { trackFolders: [{ path: change.track.path, name: change.track.name }] }
          : { untrackFolders: [change.untrack] }),
      },
    });
    onSavingChange(false);
    if (result._tag === "Failure") {
      reportProjectFailure(failureTitle, result);
      return false;
    }
    listQuery.refresh();
    return true;
  };

  const addFolder = async (folder: ProjectTrackedFolder) => {
    if (await save({ track: folder }, gt("Failed to add folder"))) onCloseAdd();
  };

  const folderName = fileDisplayName(member.workspaceRoot);
  const environmentLabel = member.environmentLabel ?? gt("Environment");
  const rootState: WorkspaceFolderState | null = scanQuery.data
    ? scanQuery.data.isGitRepository
      ? "git"
      : "plain"
    : member.repositoryIdentity
      ? "git"
      : null;
  const hasChildren = folders.length > 0 || suggested.length > 0;

  return (
    <>
      <SettingsRow
        leading={rootState === "git" ? <FolderGit2Icon /> : <FolderIcon />}
        title={folderName}
        description={
          spansEnvironments ? (
            <>
              <span className="block truncate">{environmentLabel}</span>
              <PathWithTooltip display={member.workspaceRoot} fullPath={member.workspaceRoot} />
            </>
          ) : (
            <PathWithTooltip display={member.workspaceRoot} fullPath={member.workspaceRoot} />
          )
        }
        control={
          listQuery.error || (listQuery.isPending && listQuery.data === null) || rootState ? (
            <>
              {listQuery.error ? <FolderErrorIndicator message={listQuery.error} /> : null}
              {listQuery.isPending && listQuery.data === null ? (
                <Spinner size="xs" tone="muted" aria-label={gt("Loading…")} />
              ) : null}
              {rootState ? (
                <Badge variant="secondary">{m(FOLDER_STATE_LABELS[rootState])}</Badge>
              ) : null}
            </>
          ) : undefined
        }
      >
        {hasChildren ? (
          <div className="mt-2 mb-1 ms-4 border-s border-divider ps-3 sm:ps-4 *:not-first:border-t *:not-first:border-divider">
            {folders.map((folder) => (
              <SettingsRow
                key={folder.path}
                className="rounded-none px-0 py-2 sm:px-0"
                leading={folder.state === "git" ? <FolderGit2Icon /> : <FolderIcon />}
                title={folder.name}
                description={
                  <PathWithTooltip
                    display={trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
                    fullPath={folder.path}
                  />
                }
                control={
                  folder.state || folder.discovered !== true ? (
                    <>
                      {folder.state ? (
                        <Badge variant={folder.state === "missing" ? "warning" : "secondary"}>
                          {m(FOLDER_STATE_LABELS[folder.state])}
                        </Badge>
                      ) : null}
                      {folder.discovered === true ? null : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-sm"
                                variant="ghost-destructive"
                                disabled={disabled}
                                aria-label={gt("Remove {name} from the project", {
                                  name: folder.name,
                                })}
                                onClick={() =>
                                  void save({ untrack: folder.path }, gt("Failed to remove folder"))
                                }
                              >
                                <Trash2Icon />
                              </Button>
                            }
                          />
                          <TooltipPopup side="top">
                            <T>Remove</T>
                          </TooltipPopup>
                        </Tooltip>
                      )}
                    </>
                  ) : undefined
                }
              />
            ))}
            {suggested.map((folder) => (
              <SettingsRow
                key={folder.path}
                className="rounded-none px-0 py-2 sm:px-0"
                leading={<FolderIcon />}
                title={<span className="text-muted-foreground">{folder.name}</span>}
                description={
                  <PathWithTooltip
                    display={trackedFolderDisplayPath(folder.path, member.workspaceRoot)}
                    fullPath={folder.path}
                  />
                }
                control={
                  <>
                    <Badge variant="outline">
                      <T>In workspace file</T>
                    </Badge>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={disabled}
                      aria-label={gt("Add {name} to the project", { name: folder.name })}
                      onClick={() => void save({ track: folder }, gt("Failed to add folder"))}
                    >
                      <PlusIcon />
                      <T>Add</T>
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        ) : null}
      </SettingsRow>
      {isAdding ? (
        <AddTrackedFolderDialog
          environmentId={environmentId}
          workspaceRoot={member.workspaceRoot}
          platform={getEnvironmentBrowsePlatform(
            environment?.serverConfig?.environment.platform.os,
          )}
          canBrowse={access.canReadFiles}
          busy={isSaving || listQuery.isPending}
          onAdd={(folder) => void addFolder(folder)}
          onClose={onCloseAdd}
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
                <ContentButton
                  variant="action-row"
                  className="w-full"
                  onClick={() => setQuery(parentPath)}
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  ..
                </ContentButton>
              ) : null}
              {visibleEntries.slice(0, BROWSE_SUGGESTION_LIMIT).map((entry) => (
                <ContentButton
                  key={entry.fullPath}
                  variant="action-row"
                  className="w-full"
                  onClick={() =>
                    setQuery(appendBrowsePathSegment(browsePath.directoryPath, entry.name))
                  }
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </ContentButton>
              ))}
              {browseQuery.error ? (
                <p role="alert" className="px-2 py-1.5 text-body text-muted-foreground">
                  {browseQuery.error}
                </p>
              ) : browseQuery.isPending && browseQuery.data === null ? (
                <p role="status" className="px-2 py-1.5 text-body text-muted-foreground">
                  <T>Loading folders…</T>
                </p>
              ) : hiddenCount > 0 ? (
                <p className="px-2 py-1.5 text-meta text-muted-foreground">
                  <T>
                    <Var>{hiddenCount}</Var> more. Keep typing to narrow the list.
                  </T>
                </p>
              ) : !props.canBrowse ? (
                <p className="px-2 py-1.5 text-body text-muted-foreground">
                  <T>This connection cannot browse folders. Enter an absolute path.</T>
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={props.onClose}>
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

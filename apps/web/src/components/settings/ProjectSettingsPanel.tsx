import { useComposerMenuState } from "../chat/useComposerMenuState";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { mapAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { planProjectRemoval } from "@t3tools/client-runtime/state/projects";
import { type EnvironmentId } from "@t3tools/contracts";
import {
  checkProjectAccess,
  reportProjectFailure,
  useProjectGroupUpdate,
  type ProjectGroupUpdate,
} from "../../hooks/useProjectGroupUpdate";
import { Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import { InfoIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { ProjectFavicon } from "../ProjectFavicon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import {
  defaultProjectIcon,
  hasDefaultProjectIcon,
  projectGroupTitleNeedsUpdate,
  SCRATCH_PROJECT_TITLE,
} from "./ProjectSettingsPanel.logic";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

export type ProjectSettingsCategory = "general" | "source-control" | "project";

interface ProjectSelection {
  readonly key: string;
  readonly environmentId: EnvironmentId | null;
  readonly checkoutKey: string | null;
  readonly memberKeys: ReadonlyArray<string>;
}

function sameProjectSelection(a: ProjectSelection | null, b: ProjectSelection): boolean {
  return (
    a !== null &&
    a.key === b.key &&
    a.environmentId === b.environmentId &&
    a.checkoutKey === b.checkoutKey &&
    a.memberKeys.length === b.memberKeys.length &&
    a.memberKeys.every((key, index) => key === b.memberKeys[index])
  );
}

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
  unavailable,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
  unavailable?: ReactNode;
}) {
  const groups = useSettingsProjectGroups();
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members =
    selected?.memberProjects.filter(
      (member) =>
        (environmentId === null || member.environmentId === environmentId) &&
        (checkoutKey === null || member.physicalProjectKey === checkoutKey),
    ) ?? [];

  // Retain group members so grouping-rule changes can follow the project to its new group.
  const [lastSelection, setLastSelection] = useState<ProjectSelection | null>(null);
  if (selected && members.length > 0) {
    const current: ProjectSelection = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
    if (!sameProjectSelection(lastSelection, current)) setLastSelection(current);
  }

  const successor =
    members.length === 0 &&
    lastSelection?.key === projectKey &&
    lastSelection.environmentId === environmentId &&
    lastSelection.checkoutKey === checkoutKey
      ? groups.find((group) =>
          group.memberProjects.some((member) =>
            lastSelection.memberKeys.includes(member.physicalProjectKey),
          ),
        )
      : undefined;
  if (successor) {
    return (
      <Navigate
        to={pathname}
        search={{
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }}
        replace
        hashScrollIntoView={false}
      />
    );
  }

  if ((!selected || members.length === 0) && unavailable != null) return unavailable;

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {groups.length === 0
          ? "Add a project from the sidebar to configure it here."
          : "This project is no longer available."}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        This checkout is no longer available in the selected project and environment.
      </p>
    );
  const scopedGroup = {
    ...selected,
    memberProjects: members,
    environmentId: members[0]!.environmentId,
    id: members[0]!.id,
  };
  return (
    <ProjectDetail
      key={`${selected.projectKey}:${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
      group={scopedGroup}
      allMembers={selected.memberProjects}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  allMembers,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  /** Pin and archive belong to the whole project, even when one machine is picked. */
  allMembers: ReadonlyArray<SidebarProjectGroupMember>;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(allMembers, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const threads = useThreadShells();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const projectNameEditedRef = useRef(false);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const { updateProjectGroup, canOrganizeProjectGroup } = useProjectGroupUpdate();
  const updateAllMembers = (
    input: ProjectGroupUpdate | ((member: SidebarProjectGroupMember) => ProjectGroupUpdate),
    failureTitle: string,
  ) => updateProjectGroup(group.memberProjects, input, failureTitle);
  const canOrganize =
    allMembers.every((member) => editableIds.has(member.environmentId)) &&
    canOrganizeProjectGroup(allMembers);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const organize = async (input: ProjectGroupUpdate, failureTitle: string) => {
    setIsOrganizing(true);
    await updateProjectGroup(allMembers, input, failureTitle);
    setIsOrganizing(false);
  };

  const renameGroup = async (nextTitle: string, wasEdited: boolean) => {
    const title = nextTitle.trim();
    if (!title) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        group.memberProjects.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return;
    }
    await updateAllMembers({ title }, "Failed to rename project");
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: Parameters<typeof updateAllMembers>[0]) => {
    if (savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateAllMembers(input, "Failed to update project icon");
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  const hasMultipleCheckouts = group.memberProjects.length > 1;
  const canResetScratchTitle =
    group.memberProjects.every((member) => member.isScratch) &&
    group.memberProjects.some((member) => member.title !== SCRATCH_PROJECT_TITLE);

  const removeMembers = async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
    if (checkProjectAccess(members, "Failed to remove project")) return;
    const api = readLocalApi();
    if (!api) return;

    const { projectThreads, isWholeGroup, confirmationMessage } = planProjectRemoval({
      members,
      groupMemberCount: group.memberProjects.length,
      hasOtherMembers,
      displayName: group.displayName,
      threads,
      unloadedThreadCount: readUnloadedThreadCount(members, threads),
    });
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    if (checkProjectAccess(members, "Failed to remove project")) return;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectFailure(`Failed to remove "${member.title}"`, result);
        return;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    if (isWholeGroup && !hasOtherMembers) {
      void navigate({
        to: "/settings/projects",
        search: ({ machine }) => ({ project: undefined, machine, checkout: undefined }),
        replace: true,
      });
    }
  };

  const checkoutsByEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of group.memberProjects) {
    const members = checkoutsByEnvironment.get(member.environmentId);
    if (members) members.push(member);
    else checkoutsByEnvironment.set(member.environmentId, [member]);
  }
  const checkoutRemoveButton = (member: SidebarProjectGroupMember) => (
    <Button
      size="sm"
      variant="outline"
      disabled={!editableIds.has(member.environmentId)}
      onClick={() => void removeMembers([member])}
      aria-label={`Remove checkout ${member.workspaceRoot}`}
    >
      Remove
    </Button>
  );
  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        if (checkoutsByEnvironment.size === 1) {
          return members.map((member) => (
            <SettingsRow
              key={member.physicalProjectKey}
              title={member.environmentLabel ?? "Environment"}
              description={member.workspaceRoot}
              control={checkoutRemoveButton(member)}
            />
          ));
        }
        const firstMember = members[0]!;
        const hasMultiple = members.length > 1;
        const environment = environmentById.get(environmentId);
        const labels = environment
          ? settingsScopeEnvironmentLabels(environment, environments)
          : { primary: firstMember.environmentLabel ?? "Environment", secondary: environmentId };
        return (
          <SettingsRow
            key={environmentId}
            title={labels.primary}
            description={
              <>
                {labels.secondary ? (
                  <span className="block truncate">{labels.secondary}</span>
                ) : null}
                {!hasMultiple ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate" />}>
                      {firstMember.workspaceRoot}
                    </TooltipTrigger>
                    <TooltipPopup>{firstMember.workspaceRoot}</TooltipPopup>
                  </Tooltip>
                ) : null}
              </>
            }
            control={hasMultiple ? undefined : checkoutRemoveButton(firstMember)}
          >
            {hasMultiple ? (
              <div className="space-y-3 pb-2 pt-1">
                {members.map((member) => (
                  <div
                    key={member.physicalProjectKey}
                    className="flex min-w-0 items-center justify-between gap-3"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 truncate text-xs text-muted-foreground/80" />
                        }
                      >
                        {member.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{member.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                    <div className="shrink-0">{checkoutRemoveButton(member)}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <Alert variant="info">
          <InfoIcon aria-hidden />
          <AlertDescription>
            Can't find a setting? Keep this project picked above and hop to any other settings page.
          </AlertDescription>
        </Alert>
        <SettingsSection id="project-overview" title="Project" hideTitle>
          {!canEditGroup ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
              {group.memberProjects.length > 1
                ? "Shared settings require permission to change every checkout in this group."
                : "This connection cannot change this project."}
            </p>
          ) : null}
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            resetAction={
              canResetScratchTitle ? (
                <SettingResetButton
                  label="project name"
                  disabled={!canEditGroup}
                  onClick={() =>
                    void updateAllMembers(
                      { title: SCRATCH_PROJECT_TITLE },
                      "Failed to rename project",
                    )
                  }
                />
              ) : null
            }
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
                disabled={!canEditGroup}
                defaultValue={group.displayName}
                onChange={() => {
                  projectNameEditedRef.current = true;
                }}
                onBlur={(event) => {
                  const wasEdited = projectNameEditedRef.current;
                  projectNameEditedRef.current = false;
                  void renameGroup(event.currentTarget.value, wasEdited);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Project icon"
            description={
              projectIcon?.kind === "lucide"
                ? `${projectIcon.name} · ${projectIcon.color}`
                : projectIcon?.kind === "monogram"
                  ? `${projectIcon.text} · ${projectIcon.color}`
                  : projectIcon?.kind === "emoji"
                    ? projectIcon.emoji
                    : (faviconPath ?? "Automatic")
            }
            resetAction={
              group.memberProjects.some((member) => !hasDefaultProjectIcon(member)) ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => void setProjectIcon(defaultProjectIcon)}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={representative} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
          {canOrganize ? (
            <>
              <SettingsRow
                title="Pin"
                description="Pinned projects come first in project pickers."
                control={
                  <Switch
                    checked={group.pinned}
                    disabled={isOrganizing}
                    onCheckedChange={(checked) =>
                      void organize(
                        { pinned: Boolean(checked) },
                        checked ? "Failed to pin project" : "Failed to unpin project",
                      )
                    }
                    aria-label="Pin project"
                  />
                }
              />
              <SettingsRow
                title="Archive"
                description={
                  group.archived
                    ? "Hidden from project pickers. Threads and files are kept."
                    : "Hides the project from project pickers. Threads and files are kept."
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isOrganizing}
                    onClick={() =>
                      void organize(
                        { archived: !group.archived },
                        group.archived
                          ? "Failed to unarchive project"
                          : "Failed to archive project",
                      )
                    }
                  >
                    {group.archived ? "Unarchive" : "Archive"}
                  </Button>
                }
              />
            </>
          ) : null}
        </SettingsSection>
        <ProjectDefaultsSettings category="project" />
        <ProjectActionsSettings />
        {hasMultipleCheckouts ? checkoutChoices : null}
        <SettingsSection title="Danger">
          <SettingsRow
            title={
              hasOtherMembers
                ? "Remove checkout"
                : group.memberProjects.length > 1
                  ? "Remove this project everywhere"
                  : "Remove project"
            }
            description={
              hasOtherMembers
                ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
                : group.memberProjects.length > 1
                  ? `Deletes all ${group.memberProjects.length} checkout entries and their threads on every machine. Files on disk are not touched.`
                  : "Deletes the project entry and its threads. Files on disk are not touched."
            }
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={!canEditGroup}
                onClick={() => void removeMembers(group.memberProjects)}
              >
                <Trash2Icon />
                {hasOtherMembers
                  ? "Remove checkout"
                  : group.memberProjects.length > 1
                    ? "Remove all entries"
                    : "Remove project"}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditGroup ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={representative.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}

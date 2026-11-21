import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import { m as resolveMessage } from "../../i18n/messages";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import { type EnvironmentId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useProjectGroupUpdate, type ProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import { Navigate, useLocation } from "@tanstack/react-router";
import { InfoIcon, Trash2Icon } from "lucide-react";
import { Fragment, lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { T, useGT, useMessages } from "gt-react";

import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import {
  PROJECT_GROUPING_MODE_LABELS,
  withProjectGroupingOverride,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { refreshProjectFaviconUrl } from "../../state/assets";
import { ProjectFavicon } from "../ProjectFavicon";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
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
import { ProjectCheckoutScope } from "./SettingsScopeSentence";
import {
  defaultProjectIcon,
  hasDefaultProjectIcon,
  isScratchProjectGroup,
  projectGroupTitleNeedsUpdate,
  SCRATCH_PROJECT_TITLE,
} from "./ProjectSettingsPanel.logic";
import { useRemoveProjectMembers } from "./useRemoveProjectMembers";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

function isGroupingSelection(value: unknown): value is SidebarProjectGroupingMode | "inherit" {
  return (
    value === "inherit" ||
    value === "repository" ||
    value === "repository_path" ||
    value === "separate"
  );
}

// Grouping overrides are client settings, so they stay editable without project write access.
function CheckoutGroupingSelect({ member }: { member: SidebarProjectGroupMember }) {
  const gt = useGT();
  const m = useMessages();
  const overrideKey = derivePhysicalProjectKey(member);
  const globalMode = useClientSettings((settings) => settings.sidebarProjectGroupingMode);
  const selection = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
  );
  return (
    <Select
      value={selection}
      onValueChange={(value) => {
        if (!isGroupingSelection(value)) return;
        persistClientSettingsUpdate((current) => ({
          ...current,
          sidebarProjectGroupingOverrides: withProjectGroupingOverride(
            current.sidebarProjectGroupingOverrides,
            overrideKey,
            value,
          ),
        })).catch((error) => {
          console.error("Failed to save checkout grouping rule", error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: gt("Could not save grouping rule"),
              description:
                error instanceof Error
                  ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
                  : gt("An error occurred."),
            }),
          );
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={gt("Grouping rule for {path} on {environment}", {
          path: member.workspaceRoot,
          environment: member.environmentLabel
            ? `${member.environmentLabel} (${member.environmentId})`
            : member.environmentId,
        })}
      >
        <SelectValue>
          {selection === "inherit"
            ? gt("Default ({mode})", { mode: m(PROJECT_GROUPING_MODE_LABELS[globalMode]) })
            : m(PROJECT_GROUPING_MODE_LABELS[selection])}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="inherit">
          <T>Use global default</T>
        </SelectItem>
        <SelectItem hideIndicator value="repository">
          {m(PROJECT_GROUPING_MODE_LABELS.repository)}
        </SelectItem>
        <SelectItem hideIndicator value="repository_path">
          {m(PROJECT_GROUPING_MODE_LABELS.repository_path)}
        </SelectItem>
        <SelectItem hideIndicator value="separate">
          {m(PROJECT_GROUPING_MODE_LABELS.separate)}
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}

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
  const gt = useGT();
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
          ? gt("Add a project from the sidebar to configure it here.")
          : gt("This project is no longer available.")}
      </div>
    );
  }
  if (members.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        <T>This checkout is no longer available in the selected project and environment.</T>
      </p>
    );
  return (
    <ProjectDetail
      key={selected.projectKey}
      group={selected}
      scopeKey={`${environmentId ?? "all"}:${checkoutKey ?? "all"}`}
    />
  );
}

/**
 * Identity, checkouts and removal cover every checkout. Only the sections after
 * the checkout scope picker follow the environment and checkout selection.
 */
function ProjectDetail({ group, scopeKey }: { group: SidebarProjectSnapshot; scopeKey: string }) {
  const allMembers = group.memberProjects;
  const gt = useGT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(allMembers, AuthOrchestrationOperateScope);
  const canEditGroup = group.memberProjects.every((member) =>
    editableIds.has(member.environmentId),
  );
  const filePickerProject =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const projectNameEditedRef = useRef(false);

  const faviconPath = group.faviconPath ?? null;
  const projectIcon = group.projectIcon ?? null;
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
      toastManager.add({ type: "warning", title: gt("Project title cannot be empty") });
      return;
    }
    if (!projectGroupTitleNeedsUpdate(group.memberProjects, title, wasEdited)) return;
    await updateAllMembers({ title }, gt("Failed to rename project"));
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: Parameters<typeof updateAllMembers>[0]) => {
    if (savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateAllMembers(input, gt("Failed to update project icon"));
    for (const member of group.memberProjects) {
      const update = typeof input === "function" ? input(member) : input;
      if (update.faviconPath === undefined || update.projectIcon) continue;
      refreshProjectFaviconUrl({
        environmentId: member.environmentId,
        cwd: member.workspaceRoot,
        faviconPath: update.faviconPath,
      });
    }
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  const isScratch = isScratchProjectGroup(group);
  const hasMultipleCheckouts = group.memberProjects.length > 1;
  const canResetScratchTitle =
    isScratch && group.memberProjects.some((member) => member.title !== SCRATCH_PROJECT_TITLE);

  const removeMembers = useRemoveProjectMembers({ group, allMembers, hasOtherMembers: false });

  const checkoutsByEnvironment = new Map<EnvironmentId, SidebarProjectGroupMember[]>();
  for (const member of group.memberProjects) {
    const members = checkoutsByEnvironment.get(member.environmentId);
    if (members) members.push(member);
    else checkoutsByEnvironment.set(member.environmentId, [member]);
  }
  // A lone checkout is removed from the Danger section, but it still needs its grouping
  // rule here so "Keep separate" can be undone.
  const checkoutControls = (member: SidebarProjectGroupMember) => (
    <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-auto">
      <div className="min-w-0 flex-1 @min-[32rem]/settings-row:w-72 @min-[32rem]/settings-row:flex-none">
        <CheckoutGroupingSelect member={member} />
      </div>
      {hasMultipleCheckouts && !isScratch ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!editableIds.has(member.environmentId)}
          onClick={() => void removeMembers([member])}
          aria-label={gt("Remove checkout {path}", { path: member.workspaceRoot })}
        >
          {gt("Remove", { $context: "verb, removes a checkout" })}
        </Button>
      ) : null}
    </div>
  );
  const checkoutChoices = (
    <SettingsSection title={gt("Checkouts")}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          Grouping rule decides how each checkout joins project groups in the sidebar. Changing it
          can move a checkout to a different project.
        </T>
      </p>
      {Array.from(checkoutsByEnvironment, ([environmentId, members]) => {
        if (checkoutsByEnvironment.size === 1) {
          return members.map((member) => (
            <SettingsRow
              key={member.physicalProjectKey}
              title={member.environmentLabel ?? gt("Environment")}
              description={member.workspaceRoot}
              control={checkoutControls(member)}
            />
          ));
        }
        const firstMember = members[0]!;
        const hasMultiple = members.length > 1;
        const environment = environmentById.get(environmentId);
        const labels = environment
          ? settingsScopeEnvironmentLabels(environment, environments)
          : {
              primary: firstMember.environmentLabel ?? gt("Environment"),
              secondary: environmentId,
            };
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
            control={hasMultiple ? undefined : checkoutControls(firstMember)}
          >
            {hasMultiple ? (
              <div className="space-y-3 pb-2 pt-1">
                {members.map((member) => (
                  <div
                    key={member.physicalProjectKey}
                    className="flex min-w-0 flex-col gap-1.5 @min-[36rem]/settings-row:flex-row @min-[36rem]/settings-row:items-center @min-[36rem]/settings-row:justify-between @min-[36rem]/settings-row:gap-3"
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground/80" />
                        }
                      >
                        {member.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{member.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                    <div className="shrink-0">{checkoutControls(member)}</div>
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
            <T>Can't find a setting? Other settings pages keep this project selected.</T>
          </AlertDescription>
        </Alert>
        <SettingsSection id="project-overview" title={gt("Project")} hideTitle>
          {!canEditGroup ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
              {group.memberProjects.length > 1
                ? gt("Shared settings require permission to change every checkout in this group.")
                : gt("This connection cannot change this project.")}
            </p>
          ) : null}
          <SettingsRow
            title={gt("Name")}
            description={gt(
              "The shared name for this project group in the sidebar and thread lists.",
            )}
            resetAction={
              canResetScratchTitle ? (
                <SettingResetButton
                  ariaLabel={gt("Reset project name to default")}
                  disabled={!canEditGroup}
                  onClick={() =>
                    void updateAllMembers(
                      { title: SCRATCH_PROJECT_TITLE },
                      gt("Failed to rename project"),
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
                aria-label={gt("Project name")}
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
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title={gt("Project icon")}
            description={
              projectIcon?.kind === "lucide"
                ? `${projectIcon.name} · ${projectIcon.color}`
                : projectIcon?.kind === "monogram"
                  ? `${projectIcon.text} · ${projectIcon.color}`
                  : projectIcon?.kind === "emoji"
                    ? projectIcon.emoji
                    : (faviconPath ?? gt("Automatic"))
            }
            resetAction={
              group.memberProjects.some((member) => !hasDefaultProjectIcon(member)) ? (
                <SettingResetButton
                  ariaLabel={gt("Reset project icon to default")}
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => void setProjectIcon(defaultProjectIcon)}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon project={group} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label={gt("Choose a project icon")}
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setIconPickerOpen(true)}
                >
                  <T>Choose icon</T>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label={gt("Choose a project icon file")}
                  disabled={isSavingFavicon || !canEditGroup}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  <T>Choose file</T>
                </Button>
              </div>
            }
          />
          {canOrganize ? (
            <>
              <SettingsRow
                title={gt("Pin")}
                description={gt("Pinned projects come first in project pickers.")}
                control={
                  <Switch
                    checked={group.pinned}
                    disabled={isOrganizing}
                    onCheckedChange={(checked) =>
                      void organize(
                        { pinned: Boolean(checked) },
                        checked ? gt("Failed to pin project") : gt("Failed to unpin project"),
                      )
                    }
                    aria-label={gt("Pin project")}
                  />
                }
              />
              {isScratch && !group.archived ? null : (
                <SettingsRow
                  title={gt("Archive")}
                  description={
                    group.archived
                      ? gt("Hidden from project pickers. Threads and files are kept.")
                      : gt("Hides the project from project pickers. Threads and files are kept.")
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
                            ? gt("Failed to unarchive project")
                            : gt("Failed to archive project"),
                        )
                      }
                    >
                      {group.archived
                        ? gt("Unarchive")
                        : gt("Archive", { $context: "verb, archives a project" })}
                    </Button>
                  }
                />
              )}
            </>
          ) : null}
        </SettingsSection>
        {checkoutChoices}
        <Fragment key={scopeKey}>
          <ProjectDefaultsSettings category="project" headerAction={<ProjectCheckoutScope />} />
          <ProjectActionsSettings headerAction={<ProjectCheckoutScope />} />
        </Fragment>
        {isScratch ? null : (
          <SettingsSection title={gt("Danger")}>
            <SettingsRow
              title={
                group.memberProjects.length > 1
                  ? gt("Remove this project everywhere")
                  : gt("Remove project")
              }
              description={
                group.memberProjects.length > 1
                  ? gt(
                      "{count, plural, other {Deletes all {count} checkout entries and their threads on every machine. Files on disk are not touched.}}",
                      { count: group.memberProjects.length },
                    )
                  : gt("Deletes the project entry and its threads. Files on disk are not touched.")
              }
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={!canEditGroup}
                  onClick={() => void removeMembers(group.memberProjects)}
                >
                  <Trash2Icon />
                  {group.memberProjects.length > 1
                    ? gt("Remove all entries")
                    : gt("Remove project")}
                </Button>
              }
            />
          </SettingsSection>
        )}
      </SettingsPageContainer>

      <ProjectFaviconPickerDialog
        key={`${filePickerProject.environmentId}:${filePickerProject.workspaceRoot}:${faviconPickerOpen}`}
        cwd={filePickerProject.workspaceRoot}
        environmentId={filePickerProject.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(filePickerProject.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditGroup ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={group.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}

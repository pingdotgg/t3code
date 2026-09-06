import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  deriveProjectGroupingOverrideKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectIconOverride,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
  type ProviderDriverKind,
  type SidebarProjectGroupingMode,
  type T3ProjectFileScript,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectAutoPull } from "@t3tools/shared/serverSettings";
import {
  projectScriptsInheritDefaults,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useNavigate } from "@tanstack/react-router";
import * as Equal from "effect/Equal";
import * as Cause from "effect/Cause";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { ProjectActionsList } from "./ProjectActionsList";
import { isElectron } from "../../env";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "../../lib/projectScriptKeybindings";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
} from "../../projectScripts";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

/** Logical project groups for the settings page, sorted by display name. */
export function useSettingsProjectGroups(): SidebarProjectSnapshot[] {
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [environmentLabelById, primaryEnvironmentId, projectGroupingSettings, projects],
  );
}

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate();

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members = useMemo(
    () =>
      selected?.memberProjects.filter(
        (member) => environmentId === null || member.environmentId === environmentId,
      ) ?? [],
    [selected, environmentId],
  );

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{
    key: string;
    environmentId: EnvironmentId | null;
    memberKeys: string[];
  } | null>(null);
  useEffect(() => {
    if (!selected || members.length === 0) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      environmentId,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
  }, [selected, members, environmentId]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (members.length > 0) return;
    const last = lastSelectionRef.current;
    if (last?.key !== projectKey || last.environmentId !== environmentId) return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: "/settings/projects",
        search: { project: successor.projectKey, machine: environmentId ?? undefined },
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, projectKey, members.length, environmentId]);

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
        This project has no checkout on this machine.
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
      key={`${selected.projectKey}:${environmentId ?? "all"}`}
      group={scopedGroup}
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function reportScriptFailure(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Failed to save project actions",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return mapAtomCommandResult(result, () => undefined);
}

export function useProjectScriptSettings(
  targets: readonly {
    environmentId: EnvironmentId;
    settings: ServerSettings;
    keybindings: ResolvedKeybindingsConfig;
    project?: { id: ProjectId; scripts: readonly ProjectScript[] };
  }[],
) {
  const projects = useProjects();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "project actions update");
  const upsertKeybinding = useAtomCommand(
    serverEnvironment.upsertKeybinding,
    "action shortcut update",
  );
  const removeKeybinding = useAtomCommand(
    serverEnvironment.removeKeybinding,
    "action shortcut removal",
  );

  async function persist(
    transform: (current: readonly ProjectScript[]) => readonly ProjectScript[] | null,
    scriptId?: string,
    keybinding?: string | null,
  ): Promise<AtomCommandResult<void, unknown>> {
    if (savingRef.current || targets.length === 0) {
      const message = "No available machine, or another action change is saving.";
      toastManager.add({ type: "error", title: "Actions not saved", description: message });
      return AsyncResult.failure(Cause.fail(new Error(message)));
    }
    savingRef.current = true;
    setSaving(true);
    try {
      for (const { environmentId, settings, keybindings, project } of targets) {
        const current = project
          ? resolveProjectScripts(settings, project)
          : settings.defaultProjectScripts;
        const nextScripts = transform(current);
        const effectiveScripts = nextScripts ?? settings.defaultProjectScripts;
        const result = await updateSettings({
          environmentId,
          input: {
            patch: project
              ? { projectScriptOverrides: { [project.id]: nextScripts } }
              : { defaultProjectScripts: nextScripts ?? [] },
          },
        });
        if (result._tag === "Failure") return reportScriptFailure(result);
        if (!isElectron) continue;
        const changedIds = scriptId
          ? [scriptId]
          : current
              .filter((script) => !effectiveScripts.some((next) => next.id === script.id))
              .map((script) => script.id);
        for (const id of changedIds) {
          const command = commandForProjectScript(id);
          const previousValue = keybindingValueForCommand(keybindings, command);
          const previous = previousValue
            ? decodeProjectScriptKeybindingRule({ keybinding: previousValue, command })
            : null;
          const next = decodeProjectScriptKeybindingRule({ keybinding, command });
          const retainedElsewhere =
            !nextScripts?.some((script) => script.id === id) &&
            ((project && settings.defaultProjectScripts.some((script) => script.id === id)) ||
              Object.entries(settings.projectScriptOverrides).some(
                ([projectId, scripts]) =>
                  projectId !== project?.id && scripts?.some((script) => script.id === id),
              ) ||
              projects.some(
                (other) =>
                  other.environmentId === environmentId &&
                  other.id !== project?.id &&
                  (project ? resolveProjectScripts(settings, other) : other.scripts).some(
                    (script) => script.id === id,
                  ),
              ));
          const bindingResult = next
            ? await upsertKeybinding({
                environmentId,
                input:
                  previous && previous.key !== next.key ? { ...next, replace: previous } : next,
              })
            : previous && !retainedElsewhere
              ? await removeKeybinding({ environmentId, input: previous })
              : null;
          if (bindingResult?._tag === "Failure") return reportScriptFailure(bindingResult);
        }
      }
      return AsyncResult.success(undefined);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function submit(scriptId: string | null, input: NewProjectScriptInput) {
    const existingIds = [
      ...projects.flatMap((project) => project.scripts.map((script) => script.id)),
      ...targets.flatMap(({ settings, project }) =>
        [
          ...settings.defaultProjectScripts,
          ...Object.values(settings.projectScriptOverrides).flatMap((scripts) => scripts ?? []),
          ...(project?.scripts ?? []),
        ].map((script) => script.id),
      ),
    ];
    const id = scriptId ?? nextProjectScriptId(input.name, existingIds);
    const next = buildProjectScript(id, input);
    return persist(
      (current) => {
        const updated = current.map((script) =>
          script.id === id
            ? next
            : input.runOnWorktreeCreate
              ? { ...script, runOnWorktreeCreate: false }
              : script,
        );
        return scriptId === null ? [...updated, next] : updated;
      },
      id,
      input.keybinding,
    );
  }

  return { saving, persist, submit };
}

function ProjectDetail({
  group,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  // Provider instances and model options belong to the environment that runs
  // the project's threads. The hosted app has no primary environment, so
  // reading them from there would show "No providers available" everywhere.
  const projectSettings = useEnvironmentSettings(representative.environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(representative.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const updateClientSettings = useUpdateClientSettings();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const threads = useThreadShells();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, "project setting");
  const [savingBrowserAccess, setSavingBrowserAccess] = useState(false);
  const savingBrowserAccessRef = useRef(false);
  const browserOverrides = group.memberProjects.map(
    (member) =>
      environmentById.get(member.environmentId)?.serverConfig?.settings
        .projectAgentBrowserAccessOverrides[member.id],
  );
  const browserOverride = projectSettings.projectAgentBrowserAccessOverrides[representative.id];
  const browserMixed = group.memberProjects.some((member, index) => {
    const settings = environmentById.get(member.environmentId)?.serverConfig?.settings;
    if (!settings || !environmentById.get(representative.environmentId)?.serverConfig) return false;
    return (
      browserOverrides[index] !== browserOverride ||
      (browserOverrides[index] ?? settings.enableAgentBrowserAccess) !==
        (browserOverride ?? projectSettings.enableAgentBrowserAccess)
    );
  });
  const setBooleanOverride = async (
    key: "projectAgentBrowserAccessOverrides" | "projectAutoPullOverrides",
    enabled: boolean | undefined,
  ) => {
    if (savingBrowserAccessRef.current) return;
    savingBrowserAccessRef.current = true;
    setSavingBrowserAccess(true);
    try {
      const environmentIds = new Set(group.memberProjects.map((member) => member.environmentId));
      for (const environmentId of environmentIds) {
        const environment = environmentById.get(environmentId);
        if (!environment?.serverConfig || environment.connection.phase !== "connected") {
          toastManager.add({
            type: "warning",
            title: "Setting not saved",
            description: `Connect ${environment?.label ?? "this machine"} and try again.`,
          });
          return;
        }
      }
      if (key === "projectAutoPullOverrides" && enabled === undefined) {
        const result = await updateAllMembers(
          { autoPull: false },
          "Failed to reset automatic pull",
        );
        if (result._tag === "Failure") return;
      }
      for (const environmentId of environmentIds) {
        const overrides = Object.fromEntries(
          group.memberProjects
            .filter((member) => member.environmentId === environmentId)
            .map((member) => [member.id, enabled ?? null]),
        );
        const result = await updateServerSettings({
          environmentId,
          input: { patch: { [key]: overrides } },
        });
        if (result._tag === "Failure") {
          reportFailure(
            `Failed to save project setting on ${environmentById.get(environmentId)?.label ?? "this machine"}`,
            mapAtomCommandResult(result, () => undefined),
          );
          return;
        }
      }
    } finally {
      savingBrowserAccessRef.current = false;
      setSavingBrowserAccess(false);
    }
  };
  const setBrowserAccess = (enabled: boolean | undefined) =>
    setBooleanOverride("projectAgentBrowserAccessOverrides", enabled);
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
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

  const reportFailure = useCallback((title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        defaultModelSelection: ModelSelection | null;
        defaultThreadEnvMode: ThreadEnvMode | null;
        autoPull: boolean;
        faviconPath: string | null;
        projectIcon: ProjectIconOverride | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      for (const member of group.memberProjects) {
        const result = mapAtomCommandResult(
          await updateProject({
            environmentId: member.environmentId,
            input: { projectId: member.id, ...input },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          // A partial fan-out is possible: earlier members already took the
          // write. Name the environment so the user knows where it stopped.
          reportFailure(
            group.memberProjects.length > 1
              ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
              : failureTitle,
            result,
          );
          return result;
        }
      }
      return AsyncResult.success(undefined);
    },
    [group.memberProjects, reportFailure, updateProject],
  );

  const renameGroup = useCallback(
    async (nextTitle: string, wasEdited: boolean) => {
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
    },
    [group.memberProjects, updateAllMembers],
  );

  // ----- default model -----
  const storedSelection = representative.defaultModelSelection;
  const resolvedSelection = resolveDefaultProviderModelSelection(
    serverProviders,
    storedSelection ?? projectSettings.defaultModelSelection,
  );
  const mixedModel = group.memberProjects.some((member) => {
    const config = environmentById.get(member.environmentId)?.serverConfig;
    return (
      !Equal.equals(member.defaultModelSelection, storedSelection) ||
      (config !== null &&
        config !== undefined &&
        environmentById.get(representative.environmentId)?.serverConfig != null &&
        JSON.stringify(
          resolveDefaultProviderModelSelection(
            config.providers,
            member.defaultModelSelection ?? config.settings.defaultModelSelection,
          ),
        ) !== JSON.stringify(resolvedSelection))
    );
  });
  const resolvedInstanceId = resolvedSelection?.instanceId ?? null;
  const resolvedModel = resolvedSelection?.model ?? null;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(serverProviders),
          projectSettings,
        ),
      ),
    [serverProviders, projectSettings],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        projectSettings,
        serverProviders,
        resolvedInstanceId,
        resolvedModel,
      ),
    [resolvedInstanceId, resolvedModel, serverProviders, projectSettings],
  );
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === resolvedInstanceId);
  const setDefaultModel = (selection: ModelSelection | null) => {
    if (selection !== null) {
      for (const member of group.memberProjects) {
        const environment = environmentById.get(member.environmentId);
        const config = environment?.serverConfig;
        const entry = config
          ? applyProviderInstanceSettings(
              deriveProviderInstanceEntries(config.providers),
              config.settings,
            ).find((candidate) => candidate.instanceId === selection.instanceId)
          : undefined;
        const options = config
          ? getCustomModelOptionsByInstance(
              { ...projectSettings, ...config.settings },
              config.providers,
            ).get(selection.instanceId)
          : undefined;
        if (
          !entry?.enabled ||
          !entry.isAvailable ||
          !options?.some((model) => model.slug === selection.model && !model.isUnavailable)
        ) {
          toastManager.add({
            type: "warning",
            title: "Project model not saved",
            description: `This model is unavailable on ${environment?.label ?? "a selected machine"}. Select a machine to choose its model separately.`,
          });
          return;
        }
      }
    }
    void updateAllMembers({ defaultModelSelection: selection }, "Failed to update default model");
  };

  // ----- new-thread workspace mode -----
  const storedEnvMode = representative.defaultThreadEnvMode ?? null;
  const mixedWorkspace = group.memberProjects.some(
    (member) => member.defaultThreadEnvMode !== storedEnvMode,
  );
  const setDefaultThreadEnvMode = useCallback(
    (mode: ThreadEnvMode | null) =>
      void updateAllMembers(
        { defaultThreadEnvMode: mode },
        "Failed to update new-thread workspace",
      ),
    [updateAllMembers],
  );

  const autoPull = resolveProjectAutoPull(
    projectSettings,
    representative.id,
    representative.autoPull,
  );
  const autoPullOverridden = group.memberProjects.some(
    (member) =>
      member.autoPull ||
      environmentById.get(member.environmentId)?.serverConfig?.settings.projectAutoPullOverrides[
        member.id
      ] !== undefined,
  );
  const mixedAutoPull = group.memberProjects.some((member) => {
    const settings = environmentById.get(member.environmentId)?.serverConfig?.settings;
    return settings && resolveProjectAutoPull(settings, member.id, member.autoPull) !== autoPull;
  });
  const setAutoPull = (enabled: boolean | undefined) =>
    setBooleanOverride("projectAutoPullOverrides", enabled);

  // ----- project icon -----
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = useCallback(
    async (input: { faviconPath: string | null; projectIcon: ProjectIconOverride | null }) => {
      if (savingFaviconRef.current) return;
      savingFaviconRef.current = true;
      setIsSavingFavicon(true);
      try {
        await updateAllMembers(input, "Failed to update project icon");
      } finally {
        savingFaviconRef.current = false;
        setIsSavingFavicon(false);
      }
    },
    [updateAllMembers],
  );

  // ----- checkout selection and scripts -----
  const hasMultipleCheckouts = group.memberProjects.length > 1;
  const [selectedCheckoutKey, setSelectedCheckoutKey] = useState<string | null>(null);
  const selectedCheckoutMatch = group.memberProjects.find(
    (member) => member.physicalProjectKey === selectedCheckoutKey,
  );
  const selectedCheckout = selectedCheckoutMatch ?? representative;
  const selectedServerConfig = useAtomValue(
    serverEnvironment.configValueAtom(selectedCheckout.environmentId),
  );
  const keybindings = selectedServerConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const scriptSettings = useEnvironmentSettings(selectedCheckout.environmentId);
  const scripts = resolveProjectScripts(scriptSettings, selectedCheckout);
  const scriptsInherited = projectScriptsInheritDefaults(scriptSettings, selectedCheckout);
  const [editorRequest, setEditorRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const {
    saving: isSavingScripts,
    persist: persistScripts,
    submit: submitScript,
  } = useProjectScriptSettings([
    {
      environmentId: selectedCheckout.environmentId,
      settings: scriptSettings,
      keybindings,
      project: selectedCheckout,
    },
  ]);
  const t3File = useT3ProjectFileState(
    selectedCheckout.environmentId,
    selectedCheckout.workspaceRoot,
  );
  // What the "Default" option resolves to while no override is set: the
  // repo's t3.json value when present, otherwise the global setting.
  const inheritedEnvMode = t3File.file?.defaultThreadEnvMode ?? scriptSettings.defaultThreadEnvMode;
  const inheritedEnvModeSource = t3File.file?.defaultThreadEnvMode != null ? "t3.json" : "global";
  const importableScripts = useMemo(
    () =>
      t3File.scripts.filter(
        (fileScript) =>
          !scripts.some(
            (script) =>
              script.command === fileScript.command ||
              script.name.toLowerCase() === fileScript.name.toLowerCase(),
          ),
      ),
    [scripts, t3File.scripts],
  );

  const deleteScript = (scriptId: string) =>
    void persistScripts(
      (current) => current.filter((script) => script.id !== scriptId),
      scriptId,
      null,
    );

  const importFileScript = useCallback(
    async (fileScript: T3ProjectFileScript) => {
      const payload: NewProjectScriptInput = {
        name: fileScript.name,
        command: fileScript.command,
        icon: fileScript.icon ?? "play",
        runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
        keybinding: null,
        previewUrl: fileScript.previewUrl ?? null,
        autoOpenPreview: fileScript.previewUrl ? (fileScript.autoOpenPreview ?? false) : false,
      };
      const result = await submitScript(null, payload);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setEditorRequest({
          scriptId: null,
          initial: payload,
          error: error instanceof Error ? error.message : "Failed to import action.",
        });
      }
    },
    [submitScript, setEditorRequest],
  );

  // ----- checkouts -----
  const updateGroupingPreference = useCallback(
    (member: SidebarProjectGroupMember, selection: SidebarProjectGroupingMode | "inherit") => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      const nextOverrides = { ...projectGroupingSettings.sidebarProjectGroupingOverrides };
      if (selection === "inherit") {
        delete nextOverrides[overrideKey];
      } else {
        nextOverrides[overrideKey] = selection;
      }
      updateClientSettings({ sidebarProjectGroupingOverrides: nextOverrides });
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides, updateClientSettings],
  );

  const removeMembers = useCallback(
    async (members: ReadonlyArray<SidebarProjectGroupMember>) => {
      const api = readLocalApi();
      if (!api) return;

      const memberKeys = new Set(members.map(memberKey));
      const projectThreads = threads.filter((thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
      );
      const isWholeGroup = members.length === group.memberProjects.length;
      const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
      const singleMember = members.length === 1 ? members[0]! : null;
      const targetLabel = singleMember?.title ?? group.displayName;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            projectThreads.length > 0
              ? `Remove ${targetKind} "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
              : `Remove ${targetKind} "${targetLabel}"?`,
            ...(singleMember
              ? [
                  `Path: ${singleMember.workspaceRoot}`,
                  ...(singleMember.environmentLabel
                    ? [`Environment: ${singleMember.environmentLabel}`]
                    : []),
                ]
              : [`This removes ${members.length} grouped project entries.`]),
            ...(projectThreads.length > 0
              ? [
                  "This permanently clears conversation history for those threads and any archived threads.",
                ]
              : ["This permanently clears any archived conversation history."]),
            isWholeGroup && !hasOtherMembers
              ? "This removes only the project entries, not the files on disk."
              : "Other entries in this grouped project are unaffected.",
            "This action cannot be undone.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;

      const draftStore = useComposerDraftStore.getState();
      for (const member of members) {
        const memberThreads = projectThreads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
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
          reportFailure(`Failed to remove "${member.title}"`, result);
          return;
        }
        const projectRef = scopeProjectRef(member.environmentId, member.id);
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

      if (isWholeGroup) {
        if (hasOtherMembers) {
          void navigate({
            to: "/settings/projects",
            search: { project: group.projectKey, machine: undefined },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }
    },
    [
      deleteProject,
      group.displayName,
      group.memberProjects.length,
      group.projectKey,
      hasOtherMembers,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const selectedCheckoutGrouping =
    projectGroupingSettings.sidebarProjectGroupingOverrides?.[
      deriveProjectGroupingOverrideKey(selectedCheckout)
    ] ?? "inherit";
  const checkoutLabel = (member: SidebarProjectGroupMember) => {
    const label = member.environmentLabel ?? "This machine";
    return group.memberProjects.some(
      (other) =>
        other.physicalProjectKey !== member.physicalProjectKey &&
        (other.environmentLabel ?? "This machine") === label,
    )
      ? `${label} · ${member.workspaceRoot}`
      : label;
  };
  const selectedCheckoutLabel = checkoutLabel(selectedCheckout);

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <SettingsSection title="Project" hideTitle>
          <SettingsRow
            title="Name"
            description="The shared name for this project group in the sidebar and thread lists."
            control={
              <Input
                key={`${group.projectKey}:${group.displayName}`}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project name"
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
                : projectIcon?.kind === "emoji"
                  ? projectIcon.emoji
                  : (faviconPath ?? "Automatic")
            }
            resetAction={
              faviconPath !== null || projectIcon !== null ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon}
                  onClick={() => void setProjectIcon({ faviconPath: null, projectIcon: null })}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <ProjectFavicon
                  environmentId={representative.environmentId}
                  cwd={representative.workspaceRoot}
                  projectName={representative.title}
                  faviconPath={faviconPath}
                  projectIcon={projectIcon}
                  className="size-6"
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon"
                  disabled={isSavingFavicon}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose a project icon file"
                  disabled={isSavingFavicon}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Model"
            status={
              mixedModel
                ? "Mixed defaults or overrides. Choosing a model updates all selected checkouts."
                : storedSelection === null
                  ? "Inherited"
                  : "Overridden"
            }
            description={
              storedSelection === null
                ? "Inherited from machine defaults. New threads use the default model."
                : "Overridden for this project. Reset to use the default model."
            }
            resetAction={
              group.memberProjects.some((member) => member.defaultModelSelection !== null) ? (
                <SettingResetButton
                  label="project default model"
                  tooltip="Reset to inherited model"
                  onClick={() => setDefaultModel(null)}
                />
              ) : null
            }
            control={
              resolvedSelection && activeEntry ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={resolvedSelection.instanceId}
                    model={resolvedSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onOpenProviderSetup={(instanceId) => {
                      void navigate({
                        to: "/settings/providers",
                        search: { environmentId: representative.environmentId, instanceId },
                      });
                    }}
                    onInstanceModelChange={(instanceId, model) => {
                      setDefaultModel(createModelSelection(instanceId, model));
                    }}
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind as ProviderDriverKind}
                    models={activeEntry.models}
                    model={resolvedSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={resolvedSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={projectSettings.planModeEnabled}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(nextOptions) => {
                      setDefaultModel(
                        createModelSelection(
                          resolvedSelection.instanceId,
                          resolvedSelection.model,
                          nextOptions,
                        ),
                      );
                    }}
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <SettingsRow
            title="Workspace"
            status={
              mixedWorkspace
                ? "Mixed overrides. Choosing a workspace updates all selected checkouts."
                : storedEnvMode === null
                  ? "Inherited"
                  : "Overridden"
            }
            description={
              storedEnvMode === null
                ? "Inherited from t3.json or machine defaults."
                : "Overridden for this project. Reset to inherit its workspace default."
            }
            resetAction={
              group.memberProjects.some((member) => member.defaultThreadEnvMode !== null) ? (
                <SettingResetButton
                  label="project workspace default"
                  tooltip="Reset to inherited workspace"
                  onClick={() => setDefaultThreadEnvMode(null)}
                />
              ) : null
            }
            control={
              <Select
                value={storedEnvMode ?? "inherit"}
                onValueChange={(value) => {
                  if (value === "worktree" || value === "local") {
                    setDefaultThreadEnvMode(value);
                  } else if (value === "inherit") {
                    setDefaultThreadEnvMode(null);
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label="New-thread workspace">
                  <SelectValue>
                    {storedEnvMode === null
                      ? group.memberProjects.length > 1
                        ? "Default (per checkout)"
                        : `Default (${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`
                      : resolveEnvModeLabel(storedEnvMode)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">
                    {group.memberProjects.length > 1
                      ? "Default (each checkout's t3.json or global setting)"
                      : `Default (${inheritedEnvModeSource}: ${resolveEnvModeLabel(inheritedEnvMode).toLowerCase()})`}
                  </SelectItem>
                  <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                  <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Automatically pull"
            description="Keeps the default branch current in the background when the checkout has no local changes or commits."
            status={
              mixedAutoPull
                ? "Mixed"
                : autoPullOverridden
                  ? "Overridden"
                  : `Inherited (${autoPull ? "on" : "off"})`
            }
            resetAction={
              autoPullOverridden ? (
                <SettingResetButton
                  label="automatic pull"
                  tooltip="Reset to inherited automatic pull setting"
                  disabled={savingBrowserAccess}
                  onClick={() => void setAutoPull(undefined)}
                />
              ) : null
            }
            control={
              <Switch
                checked={autoPull}
                disabled={savingBrowserAccess}
                aria-label="Automatically pull the default branch"
                onCheckedChange={(enabled) => void setAutoPull(enabled)}
              />
            }
          />
          <SettingsRow
            title="Agent browser access"
            description={
              browserMixed
                ? "Mixed defaults or overrides across selected checkouts."
                : browserOverride === undefined
                  ? "Inherited from machine defaults. Controls agent access to the preview browser."
                  : "Overridden for this project. Applies when the agent session next starts."
            }
            resetAction={
              browserOverrides.some((value) => value !== undefined) ? (
                <SettingResetButton
                  label="project browser access"
                  tooltip="Reset to inherited browser access"
                  disabled={savingBrowserAccess}
                  onClick={() => void setBrowserAccess(undefined)}
                />
              ) : null
            }
            control={
              <Select
                value={
                  browserMixed
                    ? "mixed"
                    : browserOverride === undefined
                      ? "inherit"
                      : browserOverride
                        ? "enabled"
                        : "disabled"
                }
                disabled={savingBrowserAccess}
                onValueChange={(value) => {
                  if (value === "inherit") void setBrowserAccess(undefined);
                  else if (value === "enabled" || value === "disabled")
                    void setBrowserAccess(value === "enabled");
                }}
              >
                <SelectTrigger size="sm" aria-label="Project agent browser access">
                  <SelectValue>
                    {browserMixed
                      ? "Mixed"
                      : browserOverride === undefined
                        ? `Inherit (${projectSettings.enableAgentBrowserAccess ? "on" : "off"})`
                        : browserOverride
                          ? "On"
                          : "Off"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">Inherit defaults</SelectItem>
                  <SelectItem value="enabled">On</SelectItem>
                  <SelectItem value="disabled">Off</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection title="Checkout">
          {hasMultipleCheckouts ? (
            <SettingsRow
              title="Checkout"
              description="Actions and grouping belong to this checkout."
              control={
                <Select
                  value={selectedCheckout.physicalProjectKey}
                  onValueChange={(value) => {
                    if (value) setSelectedCheckoutKey(value);
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Checkout">
                    <SelectValue className="max-w-96 truncate">{selectedCheckoutLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {group.memberProjects.map((member) => (
                      <SelectItem key={member.physicalProjectKey} value={member.physicalProjectKey}>
                        <span className="max-w-96 whitespace-normal break-all">
                          {checkoutLabel(member)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
          <SettingsRow
            title="Project grouping"
            description="How this checkout joins project groups in the sidebar. Changing it can move you to a different project group."
            resetAction={
              selectedCheckoutGrouping !== "inherit" ? (
                <SettingResetButton
                  label="project grouping"
                  tooltip="Reset to inherited project grouping"
                  onClick={() => updateGroupingPreference(selectedCheckout, "inherit")}
                />
              ) : null
            }
            control={
              <Select
                value={selectedCheckoutGrouping}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    updateGroupingPreference(selectedCheckout, value);
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={`Grouping rule for ${selectedCheckoutLabel}`}>
                  <SelectValue>
                    {selectedCheckoutGrouping === "inherit"
                      ? `Default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[selectedCheckoutGrouping]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          {group.memberProjects.length > 1 ? (
            <SettingsRow
              title="Remove checkout"
              description="Removes this checkout and its threads from the project group. Files on disk are not touched."
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  onClick={() => void removeMembers([selectedCheckout])}
                >
                  <Trash2Icon className="size-3.5" />
                  Remove checkout
                </Button>
              }
            />
          ) : null}
          <div className="flex min-h-8 flex-col items-start gap-3 px-3 pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">Actions</h3>
              <p className="text-pretty text-sm text-muted-foreground">
                {scriptsInherited
                  ? "Inherited from machine defaults."
                  : `Overridden for ${selectedCheckoutLabel}.`}
              </p>
            </div>
            <div className="flex w-full flex-wrap gap-1.5 sm:w-auto sm:shrink-0 sm:justify-end">
              {!scriptsInherited ? (
                <SettingResetButton
                  label="project actions"
                  tooltip="Reset to inherited actions"
                  disabled={isSavingScripts}
                  onClick={() => void persistScripts(() => null)}
                />
              ) : null}
              {importableScripts.length > 0 ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="xs" variant="ghost" disabled={isSavingScripts} type="button" />
                    }
                  >
                    Import scripts
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-72">
                    <MenuGroup>
                      <MenuGroupLabel>Import from t3.json</MenuGroupLabel>
                      <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                        Add actions declared by this checkout without editing them first.
                      </p>
                    </MenuGroup>
                    <MenuSeparator />
                    {importableScripts.map((fileScript) => (
                      <MenuItem
                        key={`${fileScript.name} ${fileScript.command}`}
                        onClick={() => void importFileScript(fileScript)}
                      >
                        <ScriptIcon icon={fileScript.icon ?? "play"} className="size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{fileScript.name}</div>
                          <div className="truncate font-mono text-muted-foreground">
                            {fileScript.command}
                          </div>
                        </div>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={isSavingScripts}
                onClick={() =>
                  setEditorRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })
                }
              >
                <PlusIcon className="size-3.5" />
                Add action
              </Button>
            </div>
          </div>
          <ProjectActionsList
            scripts={scripts}
            keybindings={keybindings}
            disabled={isSavingScripts}
            onEdit={(script) => setEditorRequest(editorRequestForScript(script, keybindings))}
          />
          {t3File.status === "invalid" ? (
            <SettingsRow
              title="t3.json is invalid"
              description="A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
              className="text-warning"
            />
          ) : null}
        </SettingsSection>

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

      <ProjectScriptEditorDialog
        request={editorRequest}
        scripts={scripts}
        onSubmit={submitScript}
        onDelete={deleteScript}
        onClose={() => setEditorRequest(null)}
      />
      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen}
        projectName={group.displayName}
      />
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}

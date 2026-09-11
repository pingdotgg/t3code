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
  DEFAULT_RUNTIME_MODE,
  type AgentDashboardAutomationKind,
  type ContextMenuItem,
  type GitHubAccountId,
  type ModelSelection,
  type ProjectIconOverride,
  type ProviderDriverKind,
  type EnvironmentId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
  type PullRequestMergeMethod,
  type SidebarProjectGroupingMode,
  type T3ProjectFileScript,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useLocation, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  ChevronDownIcon,
  CopyIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { resolveProjectAutoPull } from "@t3tools/shared/serverSettings";
import {
  projectScriptsInheritDefaults,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import * as Equal from "effect/Equal";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateClientSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { shortcutLabelForCommand } from "../../keybindings";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { newMessageId, newThreadId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
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
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { agentDashboardEnvironment } from "../../state/agentDashboard";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import {
  EMPTY_SERVER_PROVIDERS,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
import {
  enabledProjectAutomationKinds,
  buildProductDiscoveryConversationPrompt,
  isValidProductContextPath,
  PROJECT_AUTOMATION_KINDS,
  projectGroupTitleNeedsUpdate,
} from "./ProjectSettingsPanel.logic";

const PROJECT_AUTOMATION_SETTINGS = [
  {
    kind: "repository-review",
    title: "Repository reviews",
    description: "Periodically reviews this project's repository and records actionable findings.",
  },
  {
    kind: "continuous-improvement",
    title: "Continuous improvement",
    description: "Starts implementation work from eligible review findings for this project.",
  },
  {
    kind: "pull-request-rollup",
    title: "Pull request rollups",
    description: "Reviews outstanding pull requests and prepares them for a pre-release rollup.",
  },
  {
    kind: "inactive-worktree-cleanup",
    title: "Inactive worktree cleanup",
    description:
      "Removes inactive, clean worktrees only after confirming their current commit is saved on the configured remote.",
  },
  {
    kind: "product-opportunity-discovery",
    title: "Product opportunity discovery",
    description:
      "Uses confirmed product context to find evidence-backed UX, workflow, and capability improvements.",
  },
  {
    kind: "decision-follow-up",
    title: "Decision follow-up",
    description:
      "Starts read-only conversations about findings that need product direction or exceed automation risk.",
  },
] as const satisfies ReadonlyArray<{
  kind: AgentDashboardAutomationKind;
  title: string;
  description: string;
}>;
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

function memberKey(member: { environmentId: string; id: string }): string {
  return `${member.environmentId}:${member.id}`;
}

export type ProjectSettingsCategory = "general" | "integrations" | "source-control";

export function ProjectSettingsPanel({
  projectKey,
  environmentId = null,
  checkoutKey = null,
}: {
  projectKey: string;
  environmentId?: EnvironmentId | null;
  checkoutKey?: string | null;
}) {
  const groups = useSettingsProjectGroups();
  const navigate = useNavigate({ from: "/settings" });
  const pathname = useLocation({ select: (location) => location.pathname });

  const selected = groups.find((group) => group.projectKey === projectKey) ?? null;
  const members = useMemo(
    () =>
      selected?.memberProjects.filter(
        (member) =>
          (environmentId === null || member.environmentId === environmentId) &&
          (checkoutKey === null || member.physicalProjectKey === checkoutKey),
      ) ?? [],
    [selected, environmentId, checkoutKey],
  );

  // Remember the members of the last rendered group so a grouping-rule change
  // (which changes the group key) can follow the project to its new group.
  const lastSelectionRef = useRef<{
    key: string;
    environmentId: EnvironmentId | null;
    checkoutKey: string | null;
    memberKeys: string[];
  } | null>(null);
  useEffect(() => {
    if (!selected || members.length === 0) return;
    lastSelectionRef.current = {
      key: selected.projectKey,
      environmentId,
      checkoutKey,
      memberKeys: members.map((member) => member.physicalProjectKey),
    };
  }, [selected, members, environmentId, checkoutKey]);

  // A grouping-rule change replaces the group key mid-visit; follow the
  // project to its new key instead of parking on the not-found state.
  useEffect(() => {
    if (members.length > 0) return;
    const last = lastSelectionRef.current;
    if (
      last?.key !== projectKey ||
      last.environmentId !== environmentId ||
      last.checkoutKey !== checkoutKey
    )
      return;
    const successor = groups.find((group) =>
      group.memberProjects.some((member) => last.memberKeys.includes(member.physicalProjectKey)),
    );
    if (successor) {
      void navigate({
        to: pathname,
        search: () => ({
          project: successor.projectKey,
          machine: environmentId ?? undefined,
          checkout: checkoutKey ?? undefined,
        }),
        replace: true,
        hashScrollIntoView: false,
      });
    }
  }, [groups, navigate, pathname, projectKey, members.length, environmentId, checkoutKey]);

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
      hasOtherMembers={members.length < selected.memberProjects.length}
    />
  );
}

function ProjectDetail({
  group,
  hasOtherMembers,
}: {
  group: SidebarProjectSnapshot;
  hasOtherMembers: boolean;
}) {
  const navigate = useNavigate({ from: "/settings" });
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
  const settings = usePrimarySettings();
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
  const updateAutomationPolicy = useAtomCommand(agentDashboardEnvironment.updateRepositoryPolicy, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
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
  const mergeMethodOverrides = useClientSettings(
    (clientSettings) => clientSettings.pullRequestMergeMethodOverrides,
  );
  const projectMergeMethod = mergeMethodOverrides[group.projectKey];
  const setProjectMergeMethod = (method: PullRequestMergeMethod | null) => {
    const nextOverrides = { ...mergeMethodOverrides };
    if (method === null) delete nextOverrides[group.projectKey];
    else nextOverrides[group.projectKey] = method;
    updateClientSettings({ pullRequestMergeMethodOverrides: nextOverrides });
  };

  const automationSnapshot = useEnvironmentQuery(
    agentDashboardEnvironment.snapshot({
      environmentId: representative.environmentId,
      input: {},
    }),
  );
  const automationPolicy = automationSnapshot.data?.repositoryPolicies.find(
    (policy) => String(policy.repository.projectId) === String(representative.id),
  );
  const enabledAutomationKinds = enabledProjectAutomationKinds(automationPolicy);
  const productContextPath = automationPolicy?.productContextPath ?? "PRODUCT.md";
  const productContextConfirmedAt = automationPolicy?.productContextConfirmedAt ?? null;
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

  const threadCountByMember = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const reportFailure = useCallback(
    (title: string, result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [],
  );

  const [isSavingAutomations, setIsSavingAutomations] = useState(false);
  const savingAutomationsRef = useRef(false);
  const setAutomationTypeEnabled = useCallback(
    async (automationKind: AgentDashboardAutomationKind, enabled: boolean) => {
      if (savingAutomationsRef.current) return;
      savingAutomationsRef.current = true;
      setIsSavingAutomations(true);
      try {
        const nextEnabledAutomationKinds = new Set(enabledProjectAutomationKinds(automationPolicy));
        if (enabled) {
          nextEnabledAutomationKinds.add(automationKind);
        } else {
          nextEnabledAutomationKinds.delete(automationKind);
        }
        const enabledAutomations = PROJECT_AUTOMATION_KINDS.filter((kind) =>
          nextEnabledAutomationKinds.has(kind),
        );
        const disabledAutomations = PROJECT_AUTOMATION_KINDS.filter(
          (kind) => !nextEnabledAutomationKinds.has(kind),
        );
        const updatedAt = new Date().toISOString();
        for (const member of group.memberProjects) {
          const result = mapAtomCommandResult(
            await updateAutomationPolicy({
              environmentId: member.environmentId,
              input: {
                repository: { projectId: member.id },
                enabled: enabledAutomations.length > 0,
                enabledAutomations,
                disabledAutomations,
                updatedAt,
              },
            }),
            () => undefined,
          );
          if (result._tag === "Failure") {
            reportFailure(
              group.memberProjects.length > 1
                ? `Failed to update automations on ${member.environmentLabel ?? "the current environment"}`
                : "Failed to update project automations",
              result,
            );
            return;
          }
        }
        await automationSnapshot.refresh();
      } finally {
        savingAutomationsRef.current = false;
        setIsSavingAutomations(false);
      }
    },
    [
      automationSnapshot,
      automationPolicy,
      group.memberProjects,
      reportFailure,
      updateAutomationPolicy,
    ],
  );

  const [isSavingProductContext, setIsSavingProductContext] = useState(false);
  const savingProductContextRef = useRef(false);
  const [isStartingProductDiscovery, setIsStartingProductDiscovery] = useState(false);
  const updateProductContextPolicy = useCallback(
    async (input: {
      readonly productContextPath?: string;
      readonly productContextConfirmedAt?: string | null;
    }) => {
      if (savingProductContextRef.current) return;
      savingProductContextRef.current = true;
      setIsSavingProductContext(true);
      try {
        const updatedAt = new Date().toISOString();
        for (const member of group.memberProjects) {
          const result = mapAtomCommandResult(
            await updateAutomationPolicy({
              environmentId: member.environmentId,
              input: {
                repository: { projectId: member.id },
                ...input,
                updatedAt,
              },
            }),
            () => undefined,
          );
          if (result._tag === "Failure") {
            reportFailure("Failed to update product context", result);
            return;
          }
        }
        await automationSnapshot.refresh();
      } finally {
        savingProductContextRef.current = false;
        setIsSavingProductContext(false);
      }
    },
    [automationSnapshot, group.memberProjects, reportFailure, updateAutomationPolicy],
  );

  // Group-shared fields live on each physical project record, so a
  // group-level edit fans out to every member.
  const updateAllMembers = useCallback(
    async (
      input: Partial<{
        title: string;
        defaultModelSelection: ModelSelection | null;
        defaultThreadEnvMode: ThreadEnvMode | null;
        autoPull: boolean;
        githubAccountId: GitHubAccountId | null;
        faviconPath: string | null;
        projectIcon: ProjectIconOverride | null;
      }>,
      failureTitle: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const unavailable = group.memberProjects.find((member) => {
        const environment = environmentById.get(member.environmentId);
        return environment?.connection.phase !== "connected" || !environment.serverConfig;
      });
      if (unavailable) {
        const error = new Error(
          `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
        );
        const result: AtomCommandResult<void, unknown> = AsyncResult.failure(Cause.fail(error));
        reportFailure(failureTitle, result);
        return result;
      }
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
    [environmentById, group.memberProjects, reportFailure, updateProject],
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
  const startProductDiscoveryConversation = useCallback(async () => {
    if (isStartingProductDiscovery) return;
    if (!resolvedSelection || resolvedSelection.model.trim().length === 0) {
      toastManager.add({
        type: "error",
        title: "Enable an agent provider first",
        description: "Choose and authenticate a provider before starting product discovery.",
      });
      return;
    }
    setIsStartingProductDiscovery(true);
    try {
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = `Discover product: ${representative.title}`.slice(0, 80);
      const result = await startThreadTurn({
        environmentId: representative.environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: buildProductDiscoveryConversationPrompt({
              projectName: representative.title,
              workspaceRoot: representative.workspaceRoot,
              productContextPath,
              hasConfirmedContext: productContextConfirmedAt !== null,
            }),
            attachments: [],
          },
          modelSelection: resolvedSelection,
          titleSeed: title,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: representative.id,
              title,
              modelSelection: resolvedSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure("Could not start product discovery", result);
        }
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: representative.environmentId, threadId },
      });
    } finally {
      setIsStartingProductDiscovery(false);
    }
  }, [
    isStartingProductDiscovery,
    navigate,
    productContextConfirmedAt,
    productContextPath,
    representative,
    reportFailure,
    resolvedSelection,
    startThreadTurn,
  ]);
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
  const inheritedEnvMode = projectSettings.defaultThreadEnvMode;
  const inheritedEnvModeSource = "environment";
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

  // ----- GitHub account -----
  const storedGitHubAccountId = representative.githubAccountId ?? null;
  const setGitHubAccountId = useCallback(
    (accountId: GitHubAccountId | null) =>
      void updateAllMembers({ githubAccountId: accountId }, "Failed to update GitHub account"),
    [updateAllMembers],
  );

  // ----- favicon -----
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

  const hasMultipleCheckouts = group.memberProjects.length > 1;

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

      if (isWholeGroup && !hasOtherMembers) {
        void navigate({ to: "/", replace: true });
      }
    },
    [
      deleteProject,
      group.displayName,
      group.memberProjects.length,
      hasOtherMembers,
      navigate,
      reportFailure,
      threads,
    ],
  );

  const checkoutChoices = (
    <SettingsSection title="Checkouts">
      {group.memberProjects.map((member) => (
        <SettingsRow
          key={member.physicalProjectKey}
          title={member.environmentLabel ?? "Environment"}
          description={member.workspaceRoot}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void removeMembers([member])}
              aria-label={`Remove checkout ${member.workspaceRoot}`}
            >
              Remove
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );

  return (
    <>
      <SettingsPageContainer className="gap-6">
        <SettingsSection id="project-overview" title="Project" hideTitle>
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
              group.memberProjects.some(
                (member) => member.faviconPath != null || member.projectIcon != null,
              ) ? (
                <SettingResetButton
                  label="project icon"
                  disabled={isSavingFavicon}
                  onClick={() => void setProjectIcon({ faviconPath: null, projectIcon: null })}
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
        </SettingsSection>

        <SettingsSection title="Product context">
          <SettingsRow
            title="Product document"
            description="Repository-relative Markdown used to ground product opportunity discovery. Changing the path clears confirmation."
            control={
              <Input
                key={`${group.projectKey}:${productContextPath}`}
                className="w-full font-mono sm:w-64"
                aria-label="Product context document path"
                defaultValue={productContextPath}
                disabled={isSavingProductContext}
                onBlur={(event) => {
                  const nextPath = event.currentTarget.value.trim();
                  if (nextPath === productContextPath) return;
                  if (!isValidProductContextPath(nextPath)) {
                    event.currentTarget.value = productContextPath;
                    toastManager.add({
                      type: "warning",
                      title: "Use a repository-relative Markdown path",
                    });
                    return;
                  }
                  void updateProductContextPolicy({
                    productContextPath: nextPath,
                    productContextConfirmedAt: null,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Confirmed for automation"
            description={
              productContextConfirmedAt
                ? `Confirmed ${new Date(productContextConfirmedAt).toLocaleString()}.`
                : "Opportunity discovery stays inactive until a user confirms this document."
            }
            control={
              <Switch
                checked={productContextConfirmedAt !== null}
                disabled={isSavingProductContext}
                onCheckedChange={(checked) =>
                  void updateProductContextPolicy({
                    productContextConfirmedAt: checked ? new Date().toISOString() : null,
                  })
                }
                aria-label="Confirm product context for automation"
              />
            }
          />
          <SettingsRow
            title="Discover with AI"
            description="Starts a repository-informed interview, maintains a living draft, and asks before writing the product document."
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={isStartingProductDiscovery}
                onClick={() => void startProductDiscoveryConversation()}
              >
                <MessageCircleQuestionIcon className="size-3.5" />
                {productContextConfirmedAt ? "Review with AI" : "Start conversation"}
              </Button>
            }
          />
        </SettingsSection>

        <SettingsSection title="Automations">
          {PROJECT_AUTOMATION_SETTINGS.map((automation) => (
            <SettingsRow
              key={automation.kind}
              title={automation.title}
              description={`${automation.description} Manual actions remain available. This applies to every checkout in the project group.`}
              control={
                <Switch
                  checked={enabledAutomationKinds.includes(automation.kind)}
                  disabled={isSavingAutomations}
                  onCheckedChange={(checked) =>
                    void setAutomationTypeEnabled(automation.kind, Boolean(checked))
                  }
                  aria-label={`Allow ${automation.title.toLowerCase()} for this project`}
                />
              }
            />
          ))}
        </SettingsSection>

        <SettingsSection title="New threads">
          <SettingsRow
            title="Default merge method"
            description="Pull requests in this project start with this method. It overrides the last method selected."
            resetAction={
              projectMergeMethod !== undefined ? (
                <SettingResetButton
                  label="project merge method"
                  onClick={() => setProjectMergeMethod(null)}
                />
              ) : null
            }
            control={
              <Select
                value={projectMergeMethod ?? "inherit"}
                onValueChange={(value) =>
                  setProjectMergeMethod(
                    value === "inherit" ? null : (value as PullRequestMergeMethod),
                  )
                }
              >
                <SelectTrigger aria-label="Default pull request merge method">
                  <SelectValue>
                    {projectMergeMethod === undefined
                      ? "Last selected"
                      : PULL_REQUEST_MERGE_METHOD_LABELS[projectMergeMethod]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">Last selected</SelectItem>
                  <SelectItem value="merge">{PULL_REQUEST_MERGE_METHOD_LABELS.merge}</SelectItem>
                  <SelectItem value="squash">{PULL_REQUEST_MERGE_METHOD_LABELS.squash}</SelectItem>
                  <SelectItem value="rebase">{PULL_REQUEST_MERGE_METHOD_LABELS.rebase}</SelectItem>
                </SelectPopup>
              </Select>
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
            title="GitHub account"
            description="Used by Agent Dashboard GitHub actions and passed to every agent session in this project."
            control={
              <Select
                value={storedGitHubAccountId ?? "default"}
                onValueChange={(value) =>
                  setGitHubAccountId(
                    value === "default" ? null : (String(value) as GitHubAccountId),
                  )
                }
              >
                <SelectTrigger aria-label="GitHub account">
                  <SelectValue>
                    {storedGitHubAccountId === null
                      ? "Default GitHub authentication"
                      : (settings.githubAccounts[storedGitHubAccountId]?.label ??
                        "Configured account (missing)")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="default">Default GitHub authentication</SelectItem>
                  {Object.entries(settings.githubAccounts).map(([accountId, account]) => (
                    <SelectItem key={accountId} value={accountId}>
                      {account.label}
                      {account.login ? ` (${account.login})` : ""}
                    </SelectItem>
                  ))}
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

import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type RuntimeMode,
  type WorktreeSubmodules,
  managedRuntimeModeDenial,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { useT } from "../../hooks/useI18n";
import { useClientSettings } from "../../hooks/useSettings";
import {
  defaultModelSelectionsAreMixed,
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { firstManagedDenial } from "../../state/managedPolicy";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const WORKTREE_SUBMODULES_OPTIONS = ["recursive", "top-level", "none"] as const;
function isWorktreeSubmodules(value: string | null): value is WorktreeSubmodules {
  return value !== null && (WORKTREE_SUBMODULES_OPTIONS as readonly string[]).includes(value);
}

const RUNTIME_MODE_KEYS: Record<RuntimeMode, { label: MessageKey; description: MessageKey }> = {
  "approval-required": {
    label: "runtimeMode.approvalRequired.label",
    description: "runtimeMode.approvalRequired.description",
  },
  "auto-accept-edits": {
    label: "runtimeMode.autoAcceptEdits.label",
    description: "runtimeMode.autoAcceptEdits.description",
  },
  auto: { label: "runtimeMode.auto.label", description: "runtimeMode.auto.description" },
  "full-access": {
    label: "runtimeMode.fullAccess.label",
    description: "runtimeMode.fullAccess.description",
  },
};

const ENV_MODE_KEYS = { local: "envMode.local", worktree: "envMode.worktree" } as const;

export function ProjectDefaultsSettings({ category }: { category: ProjectSettingsCategory }) {
  const t = useT();
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const clientSettings = useClientSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const storedSelection =
    settings.defaultModelSelection === null
      ? resolveProjectDefaultProviderModelSelection(providers, settings, target?.projectId ?? null)
      : resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const selection = storedSelection
    ? resolveEffectiveDefaultModelSelection(settings, providers, storedSelection)
    : null;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = defaultModelSelectionsAreMixed(
    clientSettings,
    targets.map((candidate) => ({
      projectId: candidate.projectId,
      settings: candidate.settings,
      providers: providersByEnvironment.get(candidate.environmentId) ?? EMPTY_SERVER_PROVIDERS,
    })),
  );
  const automaticModel =
    targets.length > 0 &&
    targets.every((candidate) => candidate.settings.defaultModelSelection === null);
  const mixedFallback = useScopedSettingsMixed(["fallbackModelSelection"]);
  const fallbackSelection = settings.fallbackModelSelection ?? selection;
  const fallbackEntry = entries.find((entry) => entry.instanceId === fallbackSelection?.instanceId);
  const fallbackModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    fallbackSelection?.instanceId,
    fallbackSelection?.model,
  );
  const mixedPermissions = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedAgentCredits = useScopedSettingsMixed(["removeAgentCreditsOnMerge"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const effortDisabledReason = selection
    ? modelDisabledReason(selection.instanceId, selection.model)
    : null;

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({
        type: "error",
        title: t("settings.threads.model.notSaved"),
        description: reason,
      });
      return;
    }
    updateSettings({ defaultModelSelection: value });
  };

  const modelRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultModelSelection"]}
      mixed={mixedModel}
      id="default-model"
      title={t("settings.threads.model.title")}
      description={
        isProjectScope
          ? t("settings.threads.model.descriptionProject")
          : !unavailable && modelSource !== "project" && automaticModel
            ? t("settings.threads.model.descriptionAutomatic")
            : t("settings.threads.model.description")
      }
      status={
        mixedModel
          ? automaticModel
            ? t("settings.threads.model.mixedAutomatic")
            : t("settings.threads.model.mixed")
          : effortDisabledReason
      }
      resetAction={
        settings.defaultModelSelection !== null ? (
          <SettingResetButton
            label={t("settings.threads.model.resetLabel")}
            onClick={() => setModel(null)}
          />
        ) : null
      }
      control={
        selection && activeEntry ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              {...(mixedModel
                ? {
                    triggerLabel: automaticModel
                      ? t("settings.threads.model.automaticMixed")
                      : t("settings.layout.mixed"),
                  }
                : {})}
              getModelDisabledReason={modelDisabledReason}
              onOpenProviderSetup={(instanceId) => {
                if (representative)
                  void navigate({
                    to: "/settings/providers",
                    search: { environmentId: representative.environmentId, instanceId },
                  });
              }}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            {!mixedModel && !effortDisabledReason ? (
              <TraitsPicker
                provider={activeEntry.driverKind}
                models={activeEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {mixedModel ? t("settings.layout.mixed") : t("settings.threads.noProviders")}
          </span>
        )
      }
    />
  );
  const workspaceRow = (
    <SettingsRow
      serverScoped
      settingKeys={["defaultThreadEnvMode"]}
      mixed={mixedWorkspace}
      id={searchableSetting("new-threads").id}
      title={t("settings.threads.workspace.title")}
      description={
        isProjectScope
          ? t("settings.threads.workspace.descriptionProject")
          : t("settings.threads.workspace.description")
      }
      resetAction={
        !isProjectScope && settings.defaultThreadEnvMode !== null ? (
          <SettingResetButton
            label={t("settings.threads.workspace.resetLabel")}
            onClick={() => updateSettings({ defaultThreadEnvMode: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedWorkspace ? null : (effective?.defaultThreadEnvMode ?? null)}
          onValueChange={(value) => {
            if (value === "local" || value === "worktree")
              updateSettings({ defaultThreadEnvMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={t("settings.threads.workspace.a11y")}>
            <SelectValue>
              {(value: string | null) =>
                value === "local" || value === "worktree"
                  ? t(ENV_MODE_KEYS[value])
                  : unavailable
                    ? t("settings.threads.workspace.unavailable")
                    : t("settings.layout.mixed")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="local">{t(ENV_MODE_KEYS.local)}</SelectItem>
            <SelectItem value="worktree">{t(ENV_MODE_KEYS.worktree)}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );

  const fallbackRow = !isProjectScope ? (
    <SettingsRow
      serverScoped
      settingKeys={["fallbackModelSelection"]}
      mixed={mixedFallback}
      {...searchableSetting("fallback-model")}
      title={t("settings.threads.fallback.title")}
      description={t("settings.threads.fallback.description")}
      resetAction={
        mixedFallback || settings.fallbackModelSelection !== null ? (
          <SettingResetButton
            label={t("settings.threads.fallback.resetLabel")}
            onClick={() => updateSettings({ fallbackModelSelection: null })}
          />
        ) : null
      }
      control={
        fallbackSelection ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={representative?.environmentId ?? null}
              activeInstanceId={fallbackSelection.instanceId}
              model={fallbackSelection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={fallbackModelOptions}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel={t("settings.threads.fallback.a11y")}
              {...(mixedFallback
                ? { triggerLabel: t("settings.layout.mixed") }
                : settings.fallbackModelSelection === null
                  ? { triggerLabel: t("settings.threads.fallback.none") }
                  : {})}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) => {
                const reason = modelDisabledReason(instanceId, model);
                if (reason) {
                  toastManager.add({
                    type: "error",
                    title: t("settings.threads.fallback.notSaved"),
                    description: reason,
                  });
                  return;
                }
                updateSettings({ fallbackModelSelection: createModelSelection(instanceId, model) });
              }}
            />
            {settings.fallbackModelSelection !== null && fallbackEntry && !mixedFallback ? (
              <TraitsPicker
                provider={fallbackEntry.driverKind}
                models={fallbackEntry.models}
                model={fallbackSelection.model}
                modelOptions={fallbackSelection.options ?? []}
                allowPromptInjectedEffort={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  updateSettings({
                    fallbackModelSelection: createModelSelection(
                      fallbackSelection.instanceId,
                      fallbackSelection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{t("settings.threads.noProviders")}</span>
        )
      }
    />
  ) : null;

  return (
    <SettingsSection
      id={category === "source-control" ? "source-control-defaults" : "project-defaults"}
      title={
        category === "source-control"
          ? t("settings.code.projectDefaults.repositories")
          : t("settings.threads.newThreads.title")
      }
    >
      {category === "project" ? (
        <>
          {modelRow}
          {fallbackRow}
          {workspaceRow}
        </>
      ) : category === "general" ? (
        <>
          {modelRow}
          {fallbackRow}
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            {...searchableSetting("default-permissions")}
            title={t("settings.threads.permissions.title")}
            description={
              isProjectScope
                ? t("settings.threads.permissions.descriptionProject")
                : t("settings.threads.permissions.description")
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label={t("settings.threads.permissions.resetLabel")}
                  onClick={() =>
                    updateSettings({
                      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedPermissions ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label={t("settings.threads.permissions.a11y")}>
                  {!mixedPermissions && (
                    <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    {mixedPermissions
                      ? t("settings.layout.mixed")
                      : t(RUNTIME_MODE_KEYS[settings.defaultRuntimeMode].label)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {runtimeModeOptions.map((mode) => {
                    const option = runtimeModeConfig[mode];
                    const Icon = option.icon;
                    const managedReason = firstManagedDenial(
                      connectedEnvironments.map(
                        (environment) => environment.serverConfig?.managedPolicy,
                      ),
                      (policy) => managedRuntimeModeDenial(policy, mode),
                    );
                    return (
                      <SelectItem
                        key={mode}
                        value={mode}
                        disabled={managedReason !== undefined}
                        className="min-w-64"
                      >
                        <div className="grid gap-0.5">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {t(RUNTIME_MODE_KEYS[mode].label)}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {managedReason ?? t(RUNTIME_MODE_KEYS[mode].description)}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
          {workspaceRow}
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title={t("settings.code.projectDefaults.autoPull.title")}
            description={
              isProjectScope
                ? t("settings.code.projectDefaults.autoPull.descriptionProject")
                : t("settings.code.projectDefaults.autoPull.description")
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label={t("settings.code.projectDefaults.autoPull.resetLabel")}
                  tooltip={t("settings.code.projectDefaults.autoPull.resetTooltip")}
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={t("settings.code.projectDefaults.autoPull.a11y")}
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["removeAgentCreditsOnMerge"]}
            mixed={mixedAgentCredits}
            {...searchableSetting("remove-agent-credits-on-merge")}
            title={t("settings.code.projectDefaults.agentCredits.title")}
            description={t("settings.code.projectDefaults.agentCredits.description")}
            resetAction={
              settings.removeAgentCreditsOnMerge ? (
                <SettingResetButton
                  label={t("settings.code.projectDefaults.agentCredits.resetLabel")}
                  tooltip={t("settings.code.projectDefaults.agentCredits.resetTooltip")}
                  onClick={() => updateSettings({ removeAgentCreditsOnMerge: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label={t("settings.code.projectDefaults.agentCredits.title")}
                mixed={mixedAgentCredits}
                checked={mixedAgentCredits ? false : settings.removeAgentCreditsOnMerge}
                onCheckedChange={(enabled) =>
                  updateSettings({ removeAgentCreditsOnMerge: enabled })
                }
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...searchableSetting("pull-request-merge-method")}
            title={t("settings.code.projectDefaults.mergeMethod.title")}
            description={
              isProjectScope
                ? t("settings.code.projectDefaults.mergeMethod.descriptionProject")
                : t("settings.code.projectDefaults.mergeMethod.description")
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label={t("settings.code.projectDefaults.mergeMethod.resetLabel")}
                  tooltip={t("settings.code.projectDefaults.mergeMethod.resetTooltip")}
                  onClick={() => updateSettings({ pullRequestMergeMethod: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedMergeMethod ? null : (settings.pullRequestMergeMethod ?? "last")}
                onValueChange={(value) => {
                  if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                  else if (value === "merge" || value === "squash" || value === "rebase")
                    updateSettings({ pullRequestMergeMethod: value });
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t("settings.code.projectDefaults.mergeMethod.a11y")}
                >
                  <SelectValue>
                    {(value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? PULL_REQUEST_MERGE_METHOD_LABELS[value]
                        : value === "last"
                          ? t("settings.code.projectDefaults.mergeMethod.last")
                          : t("settings.layout.mixed")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">
                    {t("settings.code.projectDefaults.mergeMethod.last")}
                  </SelectItem>
                  <SelectItem value="merge">{PULL_REQUEST_MERGE_METHOD_LABELS.merge}</SelectItem>
                  <SelectItem value="squash">{PULL_REQUEST_MERGE_METHOD_LABELS.squash}</SelectItem>
                  <SelectItem value="rebase">{PULL_REQUEST_MERGE_METHOD_LABELS.rebase}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}

export function WorktreeSubmodulesRow() {
  const t = useT();
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedSubmodules = useScopedSettingsMixed(["worktreeSubmodules"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings
    : null;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["worktreeSubmodules"]}
      mixed={mixedSubmodules}
      {...searchableSetting("worktree-submodules")}
      title={t("settings.code.projectDefaults.submodules.title")}
      description={
        isProjectScope
          ? t("settings.code.projectDefaults.submodules.descriptionProject")
          : t("settings.code.projectDefaults.submodules.description")
      }
      resetAction={
        !isProjectScope && settings.worktreeSubmodules !== null ? (
          <SettingResetButton
            label={t("settings.code.projectDefaults.submodules.resetLabel")}
            onClick={() => updateSettings({ worktreeSubmodules: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixedSubmodules ? null : (effective?.worktreeSubmodules ?? null)}
          onValueChange={(value) => {
            if (isWorktreeSubmodules(value)) updateSettings({ worktreeSubmodules: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={t("settings.code.projectDefaults.submodules.a11y")}>
            <SelectValue>
              {(value: string | null) =>
                isWorktreeSubmodules(value)
                  ? WORKTREE_SUBMODULES_LABELS[value]
                  : unavailable
                    ? t("settings.threads.workspace.unavailable")
                    : t("settings.layout.mixed")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WORKTREE_SUBMODULES_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {WORKTREE_SUBMODULES_LABELS[option]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

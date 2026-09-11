import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";

import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
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
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const DEFAULT_RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/**
 * Rows for the settings a project may override. The same rows edit
 * environment defaults at an environment scope and project overrides at a
 * project or checkout scope; the scoped hooks route the write.
 */
export function ProjectDefaultsSettings({ category }: { category: ProjectSettingsCategory }) {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const selection = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = useScopedSettingsMixed(["defaultModelSelection"]);
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedRuntimeMode = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const mixedBrowser = useScopedSettingsMixed(["enableAgentBrowserAccess"]);
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const workspaceSource = useScopedSettingSource(["defaultThreadEnvMode"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;

  // A checkout's t3.json wins over the environment default when the project
  // has no override of its own; show which one "inherit" resolves to.
  const checkout = scope.kind === "checkout" ? scope.checkout : null;
  // The query is disabled without a checkout, so any id satisfies the hook.
  const t3File = useT3ProjectFileState(
    checkout?.environmentId ?? EnvironmentId.make("none"),
    category === "general" && checkout ? checkout.workspaceRoot : null,
  );
  const repositoryEnvMode = t3File.file?.defaultThreadEnvMode ?? null;
  const inheritedEnvModeLabel =
    workspaceSource === "project"
      ? null
      : repositoryEnvMode
        ? `${resolveEnvModeLabel(repositoryEnvMode)} (t3.json)`
        : null;

  function modelDisabledReason(instanceId: ProviderInstanceId, model: string): string | null {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const config = environment?.serverConfig;
      if (!config) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        candidate.settings,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        { ...settings, ...candidate.settings },
        config.providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  }

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    updateSettings({ defaultModelSelection: value });
  };

  return (
    <SettingsSection
      id={
        category === "general"
          ? "project-defaults"
          : category === "integrations"
            ? "browser-access"
            : "source-control-defaults"
      }
      title={
        category === "general"
          ? "New threads"
          : category === "integrations"
            ? "Browser"
            : "Repositories"
      }
    >
      {category === "general" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultModelSelection"]}
            mixed={mixedModel}
            id="default-model"
            title="Model"
            description={
              isProjectScope
                ? "Model for new threads in this project."
                : "Default model for new threads. Projects can override it."
            }
            status={
              unavailable || mixedModel || modelSource === "project"
                ? undefined
                : settings.defaultModelSelection === null
                  ? "Automatic"
                  : undefined
            }
            resetAction={
              settings.defaultModelSelection !== null ? (
                <SettingResetButton label="default model" onClick={() => setModel(null)} />
              ) : null
            }
            control={
              selection && activeEntry ? (
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
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
                  {!mixedModel ? (
                    <TraitsPicker
                      provider={activeEntry.driverKind}
                      models={activeEntry.models}
                      model={selection.model}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={selection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={settings.planModeEnabled}
                      triggerVariant="outline"
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        setModel(
                          createModelSelection(selection.instanceId, selection.model, options),
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedRuntimeMode}
            id={searchableSetting("default-access").id}
            title="Default access"
            description={
              isProjectScope
                ? "Permission mode for new threads in this project."
                : "Default permission mode for new threads. Projects can override it."
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label="default access"
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
                value={mixedRuntimeMode ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (
                    value === "approval-required" ||
                    value === "auto-accept-edits" ||
                    value === "auto" ||
                    value === "full-access"
                  ) {
                    updateSettings({ defaultRuntimeMode: value });
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label="Default access">
                  <SelectValue>
                    {(value: string | null) =>
                      value === "approval-required" ||
                      value === "auto-accept-edits" ||
                      value === "auto" ||
                      value === "full-access"
                        ? DEFAULT_RUNTIME_MODE_LABELS[value]
                        : unavailable
                          ? "Unavailable"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="approval-required">
                    {DEFAULT_RUNTIME_MODE_LABELS["approval-required"]}
                  </SelectItem>
                  <SelectItem value="auto-accept-edits">
                    {DEFAULT_RUNTIME_MODE_LABELS["auto-accept-edits"]}
                  </SelectItem>
                  <SelectItem value="auto">{DEFAULT_RUNTIME_MODE_LABELS.auto}</SelectItem>
                  <SelectItem value="full-access">
                    {DEFAULT_RUNTIME_MODE_LABELS["full-access"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["defaultThreadEnvMode"]}
            mixed={mixedWorkspace}
            id={searchableSetting("new-threads").id}
            title="Workspace"
            description={
              isProjectScope
                ? "Where new threads in this project start. A t3.json preference applies when the project has no override."
                : "Where new threads start, unless overridden by the project or t3.json."
            }
            status={
              inheritedEnvModeLabel ? `Repository default: ${inheritedEnvModeLabel}` : undefined
            }
            resetAction={
              settings.defaultThreadEnvMode !== DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode ? (
                <SettingResetButton
                  label="default workspace"
                  onClick={() =>
                    updateSettings({
                      defaultThreadEnvMode: DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedWorkspace ? null : settings.defaultThreadEnvMode}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree")
                    updateSettings({ defaultThreadEnvMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default workspace">
                  <SelectValue>
                    {(value: string | null) =>
                      value === "local" || value === "worktree"
                        ? resolveEnvModeLabel(value)
                        : unavailable
                          ? "Unavailable"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                  <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : category === "source-control" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title="Automatically pull"
            description={
              isProjectScope
                ? "Keeps this project's default branch current when the checkout has no local changes or commits."
                : "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it."
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label="default automatic pull"
                  tooltip="Reset automatic pull to off"
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Default automatic pull"
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...searchableSetting("pull-request-merge-method")}
            description={
              isProjectScope
                ? "Pull requests in this project start with this method."
                : "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device."
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label="default merge method"
                  tooltip="Reset to last selected"
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
                <SelectTrigger size="sm" aria-label="Default pull request merge method">
                  <SelectValue>
                    {(value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? PULL_REQUEST_MERGE_METHOD_LABELS[value]
                        : value === "last"
                          ? "Last selected"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">Last selected</SelectItem>
                  <SelectItem value="merge">{PULL_REQUEST_MERGE_METHOD_LABELS.merge}</SelectItem>
                  <SelectItem value="squash">{PULL_REQUEST_MERGE_METHOD_LABELS.squash}</SelectItem>
                  <SelectItem value="rebase">{PULL_REQUEST_MERGE_METHOD_LABELS.rebase}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["enableAgentBrowserAccess"]}
            mixed={mixedBrowser}
            id={searchableSetting("agent-browser-access").id}
            title="Agent browser access"
            description={
              isProjectScope
                ? "Allow agents in this project to use the shared browser. Applies when the agent session next starts."
                : "Allow agents to use the shared browser. Projects can override it."
            }
            resetAction={
              settings.enableAgentBrowserAccess !==
              DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
                <SettingResetButton
                  label="default browser access"
                  onClick={() =>
                    updateSettings({
                      enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Agent browser access"
                mixed={mixedBrowser}
                checked={mixedBrowser ? false : settings.enableAgentBrowserAccess}
                onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
              />
            }
          />
        </>
      )}
    </SettingsSection>
  );
}

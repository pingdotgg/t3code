import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { ProjectDefaultActionsSettings } from "./ProjectDefaultActionsSettings";
import { searchableSetting } from "./settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

/** Project defaults use the same environment target across every settings category. */
export function ProjectDefaultsSettings({
  environmentId,
  category,
}: {
  environmentId: EnvironmentId | null;
  category: Exclude<ProjectSettingsCategory, "overview">;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clientSettings = useClientSettings();
  const navigate = useNavigate();
  const updateSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "project defaults update",
  );
  const savingRef = useRef(new Set<string>());
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const scoped = environments.filter(
    (environment) => environmentId === null || environment.environmentId === environmentId,
  );
  const targets = scoped.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const representative =
    targets.find((environment) => environment.environmentId === primaryEnvironmentId) ?? targets[0];
  const serverSettings = representative?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const settings = { ...serverSettings, ...clientSettings };
  const storedSelection = serverSettings.defaultModelSelection;
  const selection = resolveDefaultProviderModelSelection(providers, storedSelection);
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
  const mixedModel = targets.some(
    (target) =>
      JSON.stringify(
        resolveDefaultProviderModelSelection(
          target.serverConfig?.providers ?? [],
          target.serverConfig?.settings.defaultModelSelection ?? null,
        ),
      ) !== JSON.stringify(selection),
  );
  const mixedWorkspace = targets.some(
    (target) =>
      target.serverConfig?.settings.defaultThreadEnvMode !== serverSettings.defaultThreadEnvMode,
  );
  const mixedBrowser = targets.some(
    (target) =>
      target.serverConfig?.settings.enableAgentBrowserAccess !==
      serverSettings.enableAgentBrowserAccess,
  );
  const disabled = (key: keyof ServerSettingsPatch) => targets.length === 0 || saving.has(key);
  const mixedAutoPull = targets.some(
    (target) => target.serverConfig?.settings.defaultAutoPull !== serverSettings.defaultAutoPull,
  );

  function modelDisabledReason(instanceId: ProviderInstanceId, model: string): string | null {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const target of targets) {
      const config = target.serverConfig;
      if (!config) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        config.settings,
      ).find((candidate) => candidate.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        { ...config.settings, ...clientSettings },
        config.providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return `This model is unavailable on ${target.label}. Select that environment to choose its default separately.`;
      }
    }
    return null;
  }

  async function save(patch: ServerSettingsPatch) {
    const keys = Object.keys(patch);
    if (targets.length === 0 || keys.some((key) => savingRef.current.has(key))) return;
    const nextModel = patch.defaultModelSelection;
    const reason = nextModel ? modelDisabledReason(nextModel.instanceId, nextModel.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    for (const key of keys) savingRef.current.add(key);
    setSaving(new Set(savingRef.current));
    try {
      const results = await Promise.all(
        targets.map((target) =>
          updateSettings({ environmentId: target.environmentId, input: { patch } }),
        ),
      );
      const failedTargets = targets.filter((_, index) => results[index]?._tag === "Failure");
      if (failedTargets.length > 0) {
        toastManager.add({
          type: "error",
          title: "Project defaults not saved on every environment",
          description: `Could not update ${failedTargets.map((target) => target.label).join(", ")}. Other environments may have saved the change.`,
        });
      }
    } finally {
      for (const key of keys) savingRef.current.delete(key);
      setSaving(new Set(savingRef.current));
    }
  }

  const setModel = (value: ModelSelection | null) => void save({ defaultModelSelection: value });
  if (category === "actions")
    return <ProjectDefaultActionsSettings environmentId={environmentId} />;
  return (
    <SettingsSection
      id={
        category === "general"
          ? "project-defaults"
          : category === "integrations"
            ? "browser-access"
            : "automatic-pull-defaults"
      }
      title={
        category === "general"
          ? "New threads"
          : category === "integrations"
            ? "Browser"
            : "Project defaults"
      }
    >
      {category === "general" ? (
        <>
          <SettingsRow
            serverScoped
            mixed={mixedModel}
            id="default-model"
            title="Model"
            description="Default model for new threads. Projects can override it."
            status={
              targets.length === 0
                ? undefined
                : mixedModel
                  ? "Mixed"
                  : storedSelection === null
                    ? "Automatic"
                    : undefined
            }
            resetAction={
              targets.some(
                (target) => target.serverConfig?.settings.defaultModelSelection != null,
              ) ? (
                <SettingResetButton
                  label="default model"
                  disabled={disabled("defaultModelSelection")}
                  onClick={() => setModel(null)}
                />
              ) : null
            }
            control={
              selection && activeEntry ? (
                <fieldset
                  disabled={disabled("defaultModelSelection")}
                  className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 disabled:opacity-50"
                >
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    disabled={disabled("defaultModelSelection")}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
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
                </fieldset>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <SettingsRow
            serverScoped
            id={searchableSetting("new-threads").id}
            title="Workspace"
            description="Where new threads start, unless overridden by the project or t3.json."
            resetAction={
              mixedWorkspace ||
              serverSettings.defaultThreadEnvMode !==
                DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode ? (
                <SettingResetButton
                  label="default workspace"
                  disabled={disabled("defaultThreadEnvMode")}
                  onClick={() =>
                    void save({
                      defaultThreadEnvMode: DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                disabled={disabled("defaultThreadEnvMode")}
                value={mixedWorkspace ? "mixed" : serverSettings.defaultThreadEnvMode}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree")
                    void save({ defaultThreadEnvMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default workspace">
                  <SelectValue>
                    {targets.length === 0
                      ? "Unavailable"
                      : mixedWorkspace
                        ? "Mixed"
                        : resolveEnvModeLabel(serverSettings.defaultThreadEnvMode)}
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
        <SettingsRow
          serverScoped
          mixed={mixedAutoPull}
          id="automatic-pull"
          title="Automatically pull"
          description="Keeps the default branch current when the checkout has no local changes or commits. Projects can override it."
          status={mixedAutoPull ? "Mixed" : undefined}
          resetAction={
            serverSettings.defaultAutoPull || mixedAutoPull ? (
              <SettingResetButton
                label="default automatic pull"
                tooltip="Reset automatic pull to off"
                disabled={disabled("defaultAutoPull")}
                onClick={() => void save({ defaultAutoPull: false })}
              />
            ) : null
          }
          control={
            <Switch
              aria-label="Default automatic pull"
              checked={serverSettings.defaultAutoPull}
              disabled={disabled("defaultAutoPull")}
              onCheckedChange={(enabled) => void save({ defaultAutoPull: enabled })}
            />
          }
        />
      ) : (
        <SettingsRow
          serverScoped
          id={searchableSetting("agent-browser-access").id}
          title="Agent browser access"
          description="Allow agents to use the shared browser. Projects can override it."
          resetAction={
            mixedBrowser ||
            serverSettings.enableAgentBrowserAccess !==
              DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
              <SettingResetButton
                label="default browser access"
                disabled={disabled("enableAgentBrowserAccess")}
                onClick={() =>
                  void save({
                    enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              disabled={disabled("enableAgentBrowserAccess")}
              value={
                mixedBrowser
                  ? "mixed"
                  : serverSettings.enableAgentBrowserAccess
                    ? "enabled"
                    : "disabled"
              }
              onValueChange={(value) => {
                if (value === "enabled" || value === "disabled")
                  void save({ enableAgentBrowserAccess: value === "enabled" });
              }}
            >
              <SelectTrigger size="sm" aria-label="Default agent browser access">
                <SelectValue>
                  {targets.length === 0
                    ? "Unavailable"
                    : mixedBrowser
                      ? "Mixed"
                      : serverSettings.enableAgentBrowserAccess
                        ? "Enabled"
                        : "Disabled"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="enabled">Enabled</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      )}
    </SettingsSection>
  );
}

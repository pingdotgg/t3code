import { createModelSelection } from "@t3tools/shared/model";
import { resolvePromptSuggestionModelSelection } from "@t3tools/shared/serverSettings";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function PromptSuggestionSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedEnabled = useScopedSettingsMixed(["promptSuggestionsEnabled"]);
  const mixedModel = useScopedSettingsMixed(["promptSuggestionModelSelection"]);
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(textGenerationProviders),
      settings,
      target?.projectId ?? null,
    ),
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  // Resolve against the providers this project can use, so a provider disabled for the
  // project is never picked as the fallback that gates the switch.
  const usableInstanceIds = new Set(
    instanceEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const usableProviders = textGenerationProviders.filter((provider) =>
    usableInstanceIds.has(provider.instanceId),
  );
  const defaultSelection = resolveAppModelSelectionState(settings, usableProviders);
  const usesDedicatedModel = settings.promptSuggestionModelSelection !== null;
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolvePromptSuggestionModelSelection(
        settings,
        usableProviders,
        target?.projectId ?? null,
      ),
    },
    usableProviders,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    usableProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const canEnableDedicatedModel = usableInstanceIds.has(defaultSelection.instanceId);

  const saveModel = (instanceId: typeof selection.instanceId, model: string) => {
    const reason = modelDisabledReason(instanceId, model);
    if (reason) {
      toastManager.add({
        type: "error",
        title: "Prompt suggestion model not saved",
        description: reason,
      });
      return;
    }
    updateSettings({ promptSuggestionModelSelection: createModelSelection(instanceId, model) });
  };

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["promptSuggestionsEnabled"]}
        mixed={mixedEnabled}
        {...searchableSetting("prompt-suggestions")}
        description="After the agent finishes, suggests the message you are most likely to send next. Press Tab in an empty composer to accept it, or Esc to hide it."
        control={
          <Switch
            mixed={mixedEnabled}
            checked={mixedEnabled ? false : settings.promptSuggestionsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
            }
            aria-label="Next prompt suggestions"
          />
        }
      />

      {settings.promptSuggestionsEnabled || mixedEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["promptSuggestionModelSelection"]}
          {...searchableSetting("prompt-suggestion-model")}
          description="Model that predicts your next prompt. It runs after every turn, so a fast, inexpensive model works best. Off uses the text generation model."
          control={
            connectedEnvironments.length === 0 ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its prompt suggestion model.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {(usesDedicatedModel || mixedModel) && canEnableDedicatedModel ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Prompt suggestion model"
                    {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
                    getModelDisabledReason={modelDisabledReason}
                    onInstanceModelChange={saveModel}
                  />
                ) : null}
                {usesDedicatedModel && canEnableDedicatedModel && !mixedModel && instanceEntry ? (
                  <TraitsPicker
                    provider={instanceEntry.driverKind}
                    models={instanceEntry.models}
                    model={selection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={selection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={
                      settings.planModeEnabled || selectsPlanAgent(selection.options)
                    }
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      updateSettings({
                        promptSuggestionModelSelection: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
                <Switch
                  mixed={mixedModel}
                  checked={mixedModel ? false : usesDedicatedModel}
                  disabled={!usesDedicatedModel && !canEnableDedicatedModel}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      updateSettings({ promptSuggestionModelSelection: null });
                      return;
                    }
                    saveModel(defaultSelection.instanceId, defaultSelection.model);
                  }}
                  aria-label="Use a separate prompt suggestion model"
                />
              </div>
            )
          }
        />
      ) : null}
    </>
  );
}

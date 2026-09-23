import { ProviderDriverKind } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { randomUUID } from "../../lib/utils";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function VoicePostProcessingSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = providers.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(textGenerationProviders), settings),
  );
  const hasTextGenerationProvider = instanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const modelSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: settings.speechPostProcessingModelSelection,
    },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    modelSelection.instanceId,
    modelSelection.model,
  );
  const instanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === modelSelection.instanceId,
  );
  const provider: ProviderDriverKind = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const selectedSpeechPrompt =
    settings.speechPostProcessingPrompts.find(
      (prompt) => prompt.id === settings.speechPostProcessingSelectedPromptId,
    ) ?? settings.speechPostProcessingPrompts[0];
  const hasServerTargets = connectedEnvironments.length > 0;

  return (
    <SettingsSection title="Post-processing">
      <SettingsRow
        serverScoped
        settingKeys={["speechPostProcessingEnabled"]}
        {...searchableSetting("speech-post-processing")}
        description="Polish completed voice transcripts with a provider on this project environment."
        control={
          <Switch
            checked={settings.speechPostProcessingEnabled}
            disabled={!hasServerTargets || !hasTextGenerationProvider}
            onCheckedChange={(enabled) => updateSettings({ speechPostProcessingEnabled: enabled })}
            aria-label="Enable voice post-processing"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["speechPostProcessingModelSelection"]}
        {...searchableSetting("speech-post-processing-model")}
        description="Independent from the text generation model. Runs on this project environment after transcription."
        control={
          !hasServerTargets ? (
            <span className="text-sm text-muted-foreground">Connect an environment first.</span>
          ) : !hasTextGenerationProvider ? (
            <span className="text-sm text-muted-foreground">No providers available.</span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                activeInstanceId={modelSelection.instanceId}
                model={modelSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                getModelDisabledReason={modelDisabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = modelDisabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Voice post-processing model not saved",
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({
                    speechPostProcessingModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
              {instanceEntry ? (
                <TraitsPicker
                  provider={provider}
                  models={instanceEntry.models}
                  model={modelSelection.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={modelSelection.options}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={settings.planModeEnabled}
                  triggerVariant="outline"
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    updateSettings({
                      speechPostProcessingModelSelection: createModelSelection(
                        modelSelection.instanceId,
                        modelSelection.model,
                        options,
                      ),
                    })
                  }
                />
              ) : null}
            </div>
          )
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["speechPostProcessingPrompts", "speechPostProcessingSelectedPromptId"]}
        {...searchableSetting("speech-post-processing-prompt")}
        description="Instructions used to clean the transcript. The transcript is supplied separately as untrusted text."
        control={
          selectedSpeechPrompt ? (
            <div className="w-full max-w-xl space-y-2">
              <div className="flex items-center gap-2">
                <Select
                  value={selectedSpeechPrompt.id}
                  onValueChange={(id) =>
                    id && updateSettings({ speechPostProcessingSelectedPromptId: id })
                  }
                >
                  <SelectTrigger size="sm" aria-label="Voice post-processing prompt preset">
                    <SelectValue>{selectedSpeechPrompt.name}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {settings.speechPostProcessingPrompts.map((prompt) => (
                      <SelectItem key={prompt.id} value={prompt.id}>
                        {prompt.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const prompt = {
                      id: randomUUID(),
                      name: "New prompt",
                      prompt: selectedSpeechPrompt.prompt,
                    };
                    updateSettings({
                      speechPostProcessingPrompts: [
                        ...settings.speechPostProcessingPrompts,
                        prompt,
                      ],
                      speechPostProcessingSelectedPromptId: prompt.id,
                    });
                  }}
                >
                  New
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={settings.speechPostProcessingPrompts.length <= 1}
                  onClick={() => {
                    const prompts = settings.speechPostProcessingPrompts.filter(
                      (prompt) => prompt.id !== selectedSpeechPrompt.id,
                    );
                    updateSettings({
                      speechPostProcessingPrompts: prompts,
                      speechPostProcessingSelectedPromptId: prompts[0]?.id ?? "",
                    });
                  }}
                >
                  Delete
                </Button>
              </div>
              <Input
                key={`${selectedSpeechPrompt.id}:name`}
                defaultValue={selectedSpeechPrompt.name}
                maxLength={100}
                aria-label="Voice post-processing prompt name"
                onBlur={(event) =>
                  updateSettings({
                    speechPostProcessingPrompts: settings.speechPostProcessingPrompts.map(
                      (prompt) =>
                        prompt.id === selectedSpeechPrompt.id
                          ? { ...prompt, name: event.target.value.trim() || prompt.name }
                          : prompt,
                    ),
                  })
                }
              />
              <Textarea
                key={selectedSpeechPrompt.id}
                defaultValue={selectedSpeechPrompt.prompt}
                maxLength={10_000}
                aria-label="Voice post-processing prompt"
                onBlur={(event) =>
                  updateSettings({
                    speechPostProcessingPrompts: settings.speechPostProcessingPrompts.map(
                      (prompt) =>
                        prompt.id === selectedSpeechPrompt.id
                          ? {
                              ...prompt,
                              prompt: event.target.value.trim() || prompt.prompt,
                            }
                          : prompt,
                    ),
                  })
                }
              />
            </div>
          ) : null
        }
      />
    </SettingsSection>
  );
}

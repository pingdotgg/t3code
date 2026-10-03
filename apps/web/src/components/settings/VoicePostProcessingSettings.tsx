import { DEFAULT_SPEECH_POST_PROCESSING_PROMPT, ProviderDriverKind } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import { useRef, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useClientSettingsHydrated, useUpdateClientSettings } from "../../hooks/useSettings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function VoicePostProcessingSettings() {
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const [editingCustomInstructions, setEditingCustomInstructions] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const updateClientSettings = useUpdateClientSettings();
  const clientSettingsHydrated = useClientSettingsHydrated();
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
  const modelSelection = resolveSpeechPostProcessingModelSelection(
    settings,
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
  const hasServerTargets = connectedEnvironments.length > 0;
  const customInstructions = settings.speechPostProcessingPrompt.customInstructions;
  const promptMode = editingCustomInstructions
    ? "custom"
    : settings.speechPostProcessingPrompt.mode === "custom" && !customInstructions.trim()
      ? "default"
      : settings.speechPostProcessingPrompt.mode;

  return (
    <SettingsSection title="Post-processing">
      <SettingsRow
        {...searchableSetting("speech-post-processing")}
        description="Enable cleanup for this client. Cleanup runs on each thread’s environment using its configured provider."
        control={
          <Switch
            checked={settings.speechPostProcessingEnabled}
            disabled={!clientSettingsHydrated}
            onCheckedChange={(enabled) =>
              void updateClientSettings({ speechPostProcessingEnabled: enabled })
            }
            aria-label="Enable voice post-processing"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["speechPostProcessingModelSelection"]}
        {...searchableSetting("speech-post-processing-model")}
        description={`Configure the cleanup provider on ${environment?.label ?? "the selected environment"}. Threads on that environment use it after transcription.`}
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
        {...searchableSetting("speech-correction-word")}
        description="If automatic cleanup misses your spoken corrections, enter a word or phrase you use to signal them. Transcription gets it as a hint. Post-processing uses it only when context indicates a correction."
        control={
          <div className="w-40">
            <Input
              key={settings.speechCorrectionWord}
              defaultValue={settings.speechCorrectionWord}
              maxLength={50}
              placeholder="err"
              aria-label="Explicit correction cue"
              onBlur={(event) =>
                void updateClientSettings({ speechCorrectionWord: event.target.value.trim() })
              }
            />
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("speech-post-processing-prompt")}
        description="Use the built-in transcript cleanup prompt or write your own instructions."
        control={
          <Select
            value={promptMode}
            onValueChange={(mode) => {
              if (!mode) return;
              if (mode === "custom" && !customInstructions.trim()) {
                setEditingCustomInstructions(true);
                return;
              }
              setEditingCustomInstructions(false);
              const nextInstructions =
                customInstructionsRef.current?.value.trim() || customInstructions;
              void updateClientSettings({
                speechPostProcessingPrompt: {
                  mode: mode as "default" | "custom",
                  customInstructions:
                    mode === "default" && nextInstructions === DEFAULT_SPEECH_POST_PROCESSING_PROMPT
                      ? ""
                      : nextInstructions,
                },
              });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label="Voice post-processing prompt"
            >
              <SelectValue>
                {promptMode === "custom" ? "Custom instructions" : "Improve transcription"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="default">Improve transcription</SelectItem>
              <SelectItem value="custom">Custom instructions</SelectItem>
            </SelectPopup>
          </Select>
        }
      >
        {promptMode === "custom" ? (
          <div className="w-full pt-3 pb-2">
            <Textarea
              autoFocus
              key={customInstructions}
              ref={customInstructionsRef}
              defaultValue={customInstructions}
              maxLength={10_000}
              rows={8}
              placeholder="Write instructions for cleaning voice transcripts."
              aria-label="Custom voice post-processing instructions"
              onBlur={(event) => {
                const nextInstructions = event.target.value.trim();
                if (!nextInstructions) {
                  setEditingCustomInstructions(false);
                  if (settings.speechPostProcessingPrompt.mode === "custom") {
                    void updateClientSettings({
                      speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
                    });
                  }
                  return;
                }
                if (
                  nextInstructions !== customInstructions ||
                  settings.speechPostProcessingPrompt.mode !== "custom"
                ) {
                  void updateClientSettings({
                    speechPostProcessingPrompt: {
                      mode: "custom",
                      customInstructions: nextInstructions,
                    },
                  });
                }
              }}
            />
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

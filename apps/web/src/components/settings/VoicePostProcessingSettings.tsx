import { DEFAULT_SPEECH_POST_PROCESSING_PROMPT, ProviderDriverKind } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsModelPicker } from "./SettingsModelPicker";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const emptyProvidersAtom = Atom.make(EMPTY_SERVER_PROVIDERS);

export function VoicePostProcessingSettings({ advanced = false }: { readonly advanced?: boolean }) {
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const [editingCustomInstructions, setEditingCustomInstructions] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const providers =
    useAtomValue(
      environment
        ? serverEnvironment.providersValueAtom(environment.environmentId)
        : emptyProvidersAtom,
    ) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = providers.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const hasTextGenerationProvider = instanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const modelSelection =
    resolveSpeechPostProcessingModelSelection(settings, textGenerationProviders) ??
    settings.speechPostProcessingModelSelection;
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
    <>
      {!advanced ? (
        <SettingsSection title="Transcript cleanup">
          <SettingsRow
            serverScoped
            settingKeys={["speechPostProcessingEnabled"]}
            {...searchableSetting("speech-post-processing")}
            title="Clean up transcripts"
            description="Use AI to polish your words after transcription."
            control={
              <Switch
                checked={settings.speechPostProcessingEnabled}
                disabled={!hasServerTargets || !hasTextGenerationProvider}
                onCheckedChange={(enabled) =>
                  updateSettings({ speechPostProcessingEnabled: enabled })
                }
                aria-label="Enable voice post-processing"
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["speechPostProcessingModelSelection"]}
            {...searchableSetting("speech-post-processing-model")}
            title="Cleanup model"
            description="Choose the AI model used for cleanup."
            control={
              !hasServerTargets ? (
                <span className="text-body text-muted-foreground">
                  Connect an environment first.
                </span>
              ) : !hasTextGenerationProvider ? (
                <span className="text-body text-muted-foreground">No providers available.</span>
              ) : (
                <SettingsModelPicker
                  environmentId={environment?.environmentId ?? null}
                  activeInstanceId={modelSelection.instanceId}
                  model={modelSelection.model}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
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
                  traits={
                    instanceEntry
                      ? {
                          provider,
                          models: instanceEntry.models,
                          modelOptions: modelSelection.options,
                          planModeEnabled: settings.planModeEnabled,
                          onModelOptionsChange: (options) =>
                            updateSettings({
                              speechPostProcessingModelSelection: createModelSelection(
                                modelSelection.instanceId,
                                modelSelection.model,
                                options,
                              ),
                            }),
                        }
                      : null
                  }
                />
              )
            }
          />
        </SettingsSection>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["speechCorrectionWord"]}
            {...searchableSetting("speech-correction-word")}
            title="Correction cue"
            description="An optional word or phrase that signals a spoken correction."
            control={
              <div className="w-40">
                <Input
                  key={settings.speechCorrectionWord}
                  defaultValue={settings.speechCorrectionWord}
                  maxLength={50}
                  placeholder="err"
                  aria-label="Explicit correction cue"
                  onBlur={(event) =>
                    updateSettings({ speechCorrectionWord: event.target.value.trim() })
                  }
                />
              </div>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["speechPostProcessingPrompt"]}
            {...searchableSetting("speech-post-processing-prompt")}
            title="Cleanup instructions"
            description="Use the default prompt or write your own."
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
                  updateSettings({
                    speechPostProcessingPrompt: {
                      mode: mode as "default" | "custom",
                      customInstructions:
                        mode === "default" &&
                        nextInstructions === DEFAULT_SPEECH_POST_PROCESSING_PROMPT
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
                        updateSettings({
                          speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
                        });
                      }
                      return;
                    }
                    if (
                      nextInstructions !== customInstructions ||
                      settings.speechPostProcessingPrompt.mode !== "custom"
                    ) {
                      updateSettings({
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
        </>
      )}
    </>
  );
}

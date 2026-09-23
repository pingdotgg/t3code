import { ProviderDriverKind } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

export function VoicePostProcessingSettings() {
  const [renamingPromptId, setRenamingPromptId] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<{ name: string; prompt: string } | null>(null);
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
    <SettingsSection title="Improve transcripts">
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
        serverScoped
        settingKeys={["speechCorrectionWord"]}
        {...searchableSetting("speech-correction-word")}
        description="A spoken cue for revising what you just said. Applied only when the sentence clearly contains a correction and post-processing is enabled."
        control={
          <div className="w-40">
            <Input
              key={settings.speechCorrectionWord}
              defaultValue={settings.speechCorrectionWord}
              maxLength={50}
              placeholder="err"
              aria-label="Correction word"
              onBlur={(event) =>
                updateSettings({ speechCorrectionWord: event.target.value.trim() })
              }
            />
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["speechPostProcessingPrompts", "speechPostProcessingSelectedPromptId"]}
        {...searchableSetting("speech-post-processing-prompt")}
        description="Instructions used to clean the transcript. The transcript is supplied separately as untrusted text."
      >
        {draftPrompt ? (
          <div className="w-full space-y-2 pt-3 pb-2">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
              <Input
                value={draftPrompt.name}
                maxLength={100}
                aria-label="New prompt preset name"
                onChange={(event) => setDraftPrompt({ ...draftPrompt, name: event.target.value })}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="Save prompt preset"
                      disabled={!draftPrompt.name.trim() || !draftPrompt.prompt.trim()}
                      onClick={() => {
                        const prompt = {
                          id: randomUUID(),
                          name: draftPrompt.name.trim(),
                          prompt: draftPrompt.prompt.trim(),
                        };
                        updateSettings({
                          speechPostProcessingPrompts: [
                            ...settings.speechPostProcessingPrompts,
                            prompt,
                          ],
                          speechPostProcessingSelectedPromptId: prompt.id,
                        });
                        setDraftPrompt(null);
                      }}
                    />
                  }
                >
                  <CheckIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Save preset</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Cancel new prompt preset"
                      onClick={() => setDraftPrompt(null)}
                    />
                  }
                >
                  <XIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Cancel</TooltipPopup>
              </Tooltip>
            </div>
            <Textarea
              autoFocus
              value={draftPrompt.prompt}
              maxLength={10_000}
              placeholder="Enter prompt instructions"
              aria-label="New voice post-processing prompt"
              onChange={(event) => setDraftPrompt({ ...draftPrompt, prompt: event.target.value })}
            />
          </div>
        ) : selectedSpeechPrompt ? (
          <div className="w-full space-y-2 pt-3 pb-2">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2">
              {renamingPromptId === selectedSpeechPrompt.id ? (
                <Input
                  key={selectedSpeechPrompt.id}
                  autoFocus
                  defaultValue={selectedSpeechPrompt.name}
                  maxLength={100}
                  aria-label="Rename voice post-processing prompt preset"
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    setRenamingPromptId(null);
                    if (!name || name === selectedSpeechPrompt.name) return;
                    updateSettings({
                      speechPostProcessingPrompts: settings.speechPostProcessingPrompts.map(
                        (prompt) =>
                          prompt.id === selectedSpeechPrompt.id ? { ...prompt, name } : prompt,
                      ),
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape")
                      event.currentTarget.value = selectedSpeechPrompt.name;
                    if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
                  }}
                />
              ) : (
                <Select
                  value={selectedSpeechPrompt.id}
                  onValueChange={(id) =>
                    id && updateSettings({ speechPostProcessingSelectedPromptId: id })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="min-w-0"
                    aria-label="Voice post-processing prompt preset"
                  >
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
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Rename prompt preset"
                      disabled={renamingPromptId === selectedSpeechPrompt.id}
                      onClick={() => setRenamingPromptId(selectedSpeechPrompt.id)}
                    />
                  }
                >
                  <PencilIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Rename preset</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="Create prompt preset"
                      onClick={() => setDraftPrompt({ name: "New prompt", prompt: "" })}
                    />
                  }
                >
                  <PlusIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>New preset</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete prompt preset"
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
                    />
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Delete preset</TooltipPopup>
              </Tooltip>
            </div>
            <Textarea
              key={selectedSpeechPrompt.id}
              defaultValue={selectedSpeechPrompt.prompt}
              maxLength={10_000}
              aria-label="Voice post-processing prompt"
              onBlur={(event) => {
                const promptText = event.target.value.trim();
                if (!promptText) {
                  event.target.value = selectedSpeechPrompt.prompt;
                  return;
                }
                if (promptText === selectedSpeechPrompt.prompt) return;
                updateSettings({
                  speechPostProcessingPrompts: settings.speechPostProcessingPrompts.map((prompt) =>
                    prompt.id === selectedSpeechPrompt.id
                      ? { ...prompt, prompt: promptText }
                      : prompt,
                  ),
                });
              }}
            />
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

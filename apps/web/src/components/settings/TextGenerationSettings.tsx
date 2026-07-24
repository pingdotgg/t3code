import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";
import type { TextGenerationStyleMode } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const MODE_OPTIONS: Record<TextGenerationStyleMode, { label: string; description: string }> = {
  repo_conventions: {
    label: "Repository conventions",
    description:
      "In each project, matches recent commit messages for commits and pull request titles.",
  },
  conventional_commits: {
    label: "Conventional Commits",
    description:
      "Uses Conventional Commit prefixes for commits; pull request titles and descriptions stay concise.",
  },
  custom: {
    label: "Custom instructions",
    description:
      "Applies your instructions to commit messages and pull request titles and descriptions in every project.",
  },
};

export function TextGenerationSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const customInstructionsRef = useRef<HTMLTextAreaElement>(null);
  const style = settings.textGenerationStyle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.textGenerationStyle;
  const isGitWritingStyleDirty =
    style.mode !== defaults.mode || style.customInstructions !== defaults.customInstructions;

  const defaultModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const gitWriterSelection = settings.gitWriterModelSelection;
  const usesDedicatedModel = gitWriterSelection !== null;
  const activeSelection =
    gitWriterSelection && isModelSelectionProviderEnabled(settings, gitWriterSelection)
      ? gitWriterSelection
      : defaultModelSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );

  return (
    <SettingsSection title="Text generation">
      <SettingsRow
        title="Git writing style"
        description={MODE_OPTIONS[style.mode].description}
        resetAction={
          isGitWritingStyleDirty ? (
            <SettingResetButton
              label="text generation style"
              onClick={() =>
                updateSettings({
                  textGenerationStyle: {
                    mode: defaults.mode,
                    customInstructions: defaults.customInstructions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={style.mode}
            onValueChange={(value) => {
              const customInstructions = customInstructionsRef.current?.value.trim();
              updateSettings({
                textGenerationStyle: {
                  mode: value as TextGenerationStyleMode,
                  ...(customInstructions !== undefined ? { customInstructions } : {}),
                },
              });
            }}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="Git writing style">
              <SelectValue>{MODE_OPTIONS[style.mode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_OPTIONS) as TextGenerationStyleMode[]).map((mode) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {MODE_OPTIONS[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {style.mode === "custom" ? (
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={style.customInstructions}
              ref={customInstructionsRef}
              defaultValue={style.customInstructions}
              onBlur={(event) => {
                const customInstructions = event.target.value.trim();
                if (customInstructions !== style.customInstructions) {
                  updateSettings({ textGenerationStyle: { customInstructions } });
                }
              }}
              rows={4}
              placeholder="Keep titles concise. Use short bullet points in descriptions."
              aria-label="Custom Git writing instructions"
            />
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        title="Follow pull request templates"
        description="Structures pull request descriptions using the current repository's template when one is available."
        resetAction={
          style.followPrTemplates !== defaults.followPrTemplates ? (
            <SettingResetButton
              label="pull request templates"
              onClick={() =>
                updateSettings({
                  textGenerationStyle: { followPrTemplates: defaults.followPrTemplates },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={style.followPrTemplates}
            onCheckedChange={(checked) =>
              updateSettings({ textGenerationStyle: { followPrTemplates: Boolean(checked) } })
            }
            aria-label="Follow pull request templates"
          />
        }
      />

      <SettingsRow
        title="Git writer model"
        description="Optional model override for commit messages, pull request titles and descriptions, and branch names. Off uses the global text generation model."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {usesDedicatedModel ? (
              <ProviderModelPicker
                activeInstanceId={activeSelection.instanceId}
                model={activeSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                triggerAriaLabel="Git writer model"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    gitWriterModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
            ) : null}
            <Switch
              checked={usesDedicatedModel}
              onCheckedChange={(checked) =>
                updateSettings({
                  gitWriterModelSelection: checked
                    ? createModelSelection(
                        defaultModelSelection.instanceId,
                        defaultModelSelection.model,
                        defaultModelSelection.options,
                      )
                    : null,
                })
              }
              aria-label="Use a separate Git writer model"
            />
          </div>
        }
      />
    </SettingsSection>
  );
}

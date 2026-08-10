/**
 * Code review settings: which agent reviews pull requests, and what it is told
 * to look for.
 *
 * The model row mirrors "Source control writer model": off means the review
 * thread just uses the model it would have used anyway, so turning this on is
 * opt-in rather than a hidden override.
 */
import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";

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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

export function CodeReviewSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);

  const defaultInstructions = DEFAULT_UNIFIED_SETTINGS.codeReviewInstructions;
  const instructions = settings.codeReviewInstructions;
  const usesDedicatedModel = settings.codeReviewModelSelection !== null;

  const defaultModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const activeSelection = settings.codeReviewModelSelection ?? defaultModelSelection;
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
    <SettingsSection title="Code review">
      <SettingsRow
        title="Default code review agent"
        description="Model used when reviewing a pull request from the Code Review & PRs panel. Off reviews with the model the review thread would use anyway."
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
                triggerAriaLabel="Default code review agent"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    codeReviewModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
            ) : null}
            <Switch
              checked={usesDedicatedModel}
              onCheckedChange={(checked) =>
                updateSettings({
                  codeReviewModelSelection: checked
                    ? createModelSelection(
                        defaultModelSelection.instanceId,
                        defaultModelSelection.model,
                        defaultModelSelection.options,
                      )
                    : null,
                })
              }
              aria-label="Use a dedicated code review agent"
            />
          </div>
        }
      />

      <SettingsRow
        title="Review instructions"
        description="Sent to the review agent with every pull request, after the change request's metadata."
        resetAction={
          instructions !== defaultInstructions ? (
            <SettingResetButton
              label="review instructions"
              onClick={() => updateSettings({ codeReviewInstructions: defaultInstructions })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={instructions}
            ref={instructionsRef}
            defaultValue={instructions}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== instructions) {
                updateSettings({ codeReviewInstructions: next });
              }
            }}
            rows={8}
            placeholder={defaultInstructions}
            aria-label="Code review instructions"
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

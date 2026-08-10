import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

export function PlanReviewSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const defaultInstructions = DEFAULT_UNIFIED_SETTINGS.planReviewInstructions;
  const instructions = settings.planReviewInstructions;
  const usesDedicatedModel = settings.planReviewModelSelection !== null;
  const sourceModel = resolveAppModelSelectionState(settings, serverProviders);
  const activeSelection = settings.planReviewModelSelection ?? sourceModel;
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
    <SettingsSection title="Plan review">
      <SettingsRow
        {...{ id: "plan-review-agent" }}
        title="Default plan review agent"
        description="Optional model override for reviewing plans. Off uses the model selected on the plan's thread; every review can still choose a different agent."
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
                triggerAriaLabel="Default plan review agent"
                onInstanceModelChange={(instanceId, model) => {
                  updateSettings({
                    planReviewModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
            ) : null}
            <Switch
              checked={usesDedicatedModel}
              onCheckedChange={(checked) =>
                updateSettings({
                  planReviewModelSelection: checked
                    ? createModelSelection(
                        sourceModel.instanceId,
                        sourceModel.model,
                        sourceModel.options,
                      )
                    : null,
                })
              }
              aria-label="Use a dedicated plan review agent"
            />
          </div>
        }
      />

      <SettingsRow
        {...{ id: "plan-review-instructions" }}
        title="Plan review instructions"
        description="Sent to the reviewing agent with every plan."
        resetAction={
          instructions !== defaultInstructions ? (
            <SettingResetButton
              label="plan review instructions"
              onClick={() => updateSettings({ planReviewInstructions: defaultInstructions })}
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
                updateSettings({ planReviewInstructions: next });
              }
            }}
            rows={8}
            placeholder={defaultInstructions}
            aria-label="Plan review instructions"
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

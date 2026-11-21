import type { ModelSelection } from "@lathe/contracts";
import { createModelSelection } from "@lathe/shared/model";
import { resolveRoadmapStewardModelSelection } from "@lathe/shared/serverSettings";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
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
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left?.instanceId === right?.instanceId && left?.model === right?.model;

/**
 * Fork: roadmap. The steward's model, kept per environment because each
 * machine has its own provider logins. Mirrors the review guide model row:
 * off uses the text generation model.
 */
export function RoadmapStewardModelRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, targets } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const first = targets[0];
  const mixed =
    first !== undefined &&
    targets.some(
      (candidate) =>
        !sameSelection(
          candidate.settings.roadmap.stewardModelSelection,
          first.settings.roadmap.stewardModelSelection,
        ),
    );
  const providersByEnvironment = useEnvironmentProviders();
  const providers = (
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS
  ).filter((provider) => provider.supportsTextGeneration !== false);
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const usesStewardModel = settings.roadmap.stewardModelSelection !== null;
  const fallback = resolveAppModelSelectionState(settings, providers);
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveRoadmapStewardModelSelection(settings, providers),
    },
    providers,
  );
  const canUseStewardModel = instanceEntries.some(
    (entry) => entry.instanceId === fallback.instanceId && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const save = (stewardModelSelection: ModelSelection | null) =>
    updateSettings({ roadmap: { stewardModelSelection } });
  const refuse = (reason: string) =>
    toastManager.add({ type: "error", title: "Steward model not saved", description: reason });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["roadmap"]}
      {...searchableSetting("roadmap-steward-model")}
      description="Model this environment's steward runs on. Each environment keeps its own, since logins differ per machine. It reads a few turns at a time, so a small model works. Off uses the text generation model."
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Connect an environment to choose its steward model.
          </span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {(usesStewardModel || mixed) && canUseStewardModel ? (
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel="Steward model"
                {...(mixed ? { triggerLabel: "Mixed" } : {})}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) return refuse(reason);
                  save(createModelSelection(instanceId, model));
                }}
              />
            ) : null}
            {usesStewardModel && canUseStewardModel && !mixed && instanceEntry ? (
              <TraitsPicker
                provider={instanceEntry.driverKind}
                models={instanceEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                includePlanAgent={selectsPlanAgent(selection.options)}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  save(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            ) : null}
            <Switch
              mixed={mixed}
              checked={mixed ? false : usesStewardModel}
              disabled={!usesStewardModel && !canUseStewardModel}
              onCheckedChange={(checked) => {
                if (!checked) return save(null);
                const reason = disabledReason(fallback.instanceId, fallback.model);
                if (reason) return refuse(reason);
                save(createModelSelection(fallback.instanceId, fallback.model, fallback.options));
              }}
              aria-label="Use a separate steward model"
            />
          </div>
        )
      }
    />
  );
}

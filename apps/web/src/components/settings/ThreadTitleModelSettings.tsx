import { createModelSelection } from "@t3tools/shared/model";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useTextGenerationTargets } from "../../textGenerators";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Off, each thread titles itself with its own provider and model. */
export function ThreadTitleModelSettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const pinned = settings.threadTitleModelSelection;
  const targets = useTextGenerationTargets({
    environmentId: environment?.environmentId ?? null,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [pinned ?? settings.textGenerationModelSelection],
  });
  const selection = resolveAppModelSelectionState(
    { ...settings, textGenerationModelSelection: pinned ?? settings.textGenerationModelSelection },
    targets.providers,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, targets.entries);
  const hasProvider = targets.entries.some((entry) => entry.enabled && entry.isAvailable);
  const setModel = (next: ReturnType<typeof createModelSelection>) => {
    const reason = modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({ type: "error", title: "Title model not saved", description: reason });
      return;
    }
    updateSettings({ threadTitleModelSelection: next });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["threadTitleModelSelection"]}
      {...searchableSetting("thread-title-model")}
      description="Off, each thread is titled by its own provider and model, reusing its session when the provider can fork it. On, every title uses the model you pick."
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">Connect an environment first.</span>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {pinned !== null && hasProvider ? (
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={targets.entries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  targets.providers,
                  selection.instanceId,
                  selection.model,
                )}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                getModelDisabledReason={modelDisabledReason}
                onInstanceModelChange={(instanceId, model) =>
                  setModel(createModelSelection(instanceId, model))
                }
              />
            ) : null}
            <Switch
              checked={pinned !== null}
              disabled={pinned === null && !hasProvider}
              onCheckedChange={(checked) =>
                updateSettings({
                  threadTitleModelSelection: checked
                    ? createModelSelection(selection.instanceId, selection.model)
                    : null,
                })
              }
              aria-label="Use one model for thread titles"
            />
          </div>
        )
      }
    />
  );
}

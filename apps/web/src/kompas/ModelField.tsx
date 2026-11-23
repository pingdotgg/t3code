import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../components/settings/scheduledTasksSettings.logic";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { providerInstanceEntriesFor } from "../providerInstances";
import { serverEnvironment } from "../state/server";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

function useModelEntries(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? NO_PROVIDERS;
  return { settings, providers, entries: providerInstanceEntriesFor(providers, settings, null) };
}

/** The model a new conversation starts with, or null while no provider is ready. */
export function useDefaultModel(environmentId: EnvironmentId): ModelSelection | null {
  const { settings, entries } = useModelEntries(environmentId);
  return scheduledTaskDefaultModel(settings, null, entries);
}

export function ModelField(props: {
  readonly environmentId: EnvironmentId;
  readonly value: ModelSelection;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { settings, providers, entries } = useModelEntries(props.environmentId);
  return (
    <div>
      <ProviderModelPicker
        environmentId={props.environmentId}
        activeInstanceId={props.value.instanceId}
        model={props.value.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          settings,
          providers,
          props.value.instanceId,
          props.value.model,
        )}
        isComposerOwned={false}
        onInstanceModelChange={(instanceId, model) => props.onChange({ instanceId, model })}
      />
    </div>
  );
}

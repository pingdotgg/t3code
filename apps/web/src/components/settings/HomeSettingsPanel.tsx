import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  HomeSettings,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { homeFailure, type HomeFailure } from "../home/homeErrors";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { scheduledTaskDefaultModel } from "./scheduledTasksSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function HomeSettingsPanel() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = (environment ?? connectedEnvironments[0])?.environmentId ?? null;
  return environmentId === null ? null : <EnvironmentHomeSettings environmentId={environmentId} />;
}

function EnvironmentHomeSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const home = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.home ?? null,
  );
  return home === null ? null : <HomeSettingsContent environmentId={environmentId} home={home} />;
}

function HomeSettingsContent({
  environmentId,
  home,
}: {
  readonly environmentId: EnvironmentId;
  readonly home: HomeSettings;
}) {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(serverEnvironment.enableHome.permissionAtom(environmentId));
  const enable = useAtomCommand(serverEnvironment.enableHome, { label: "home enable" });
  const disable = useAtomCommand(serverEnvironment.disableHome, { label: "home disable" });
  const reset = useAtomCommand(serverEnvironment.resetHome, { label: "home reset" });
  const setModel = useAtomCommand(serverEnvironment.setHomeModel, { label: "home set model" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HomeFailure | null>(null);
  // Picked while Home is off, it is sent along when Home is turned on.
  const [picked, setPicked] = useState<ModelSelection | null>(null);

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const selection =
    picked ??
    home.modelSelection ??
    scheduledTaskDefaultModel(settings, null, instanceEntries) ??
    null;
  const shownInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const shownModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    shownInstanceId,
    shownModel,
  );
  const target = { environmentId, input: {} };

  const run = async (action: () => ReturnType<typeof enable | typeof disable>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await action();
    setBusy(false);
    setFailure(homeFailure(result, m));
  };
  const toggle = (on: boolean) =>
    run(() =>
      on
        ? enable({ environmentId, input: selection === null ? {} : { modelSelection: selection } })
        : disable(target),
    );
  const pickModel = (instanceId: ProviderInstanceId, model: string) => {
    const next = { instanceId, model };
    setPicked(next);
    if (home.enabled) void run(() => setModel({ environmentId, input: { modelSelection: next } }));
  };
  const startFresh = async () => {
    const confirmed = await (requestConfirmDialog(
      gt(
        "Start Home fresh? It begins a new conversation. Its notes, preferences and crew carry over, and the old thread is kept.",
      ),
    ) ?? Promise.resolve(false));
    if (confirmed) await run(() => reset(target));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...setting("home")}>
        <SettingsRow
          title={gt("Enable Home")}
          description={gt(
            "One agent on this environment that works across your projects and linked environments.",
          )}
          status={
            failure === null ? null : (
              <span className="text-destructive" role="alert">
                {failure.message}
              </span>
            )
          }
          control={
            <Switch
              checked={home.enabled}
              disabled={!canOperate || busy}
              onCheckedChange={(checked) => void toggle(Boolean(checked))}
              aria-label={gt("Enable Home")}
            />
          }
        />
        <SettingsRow
          title={gt("Model")}
          description={gt("The model Home runs on.")}
          control={
            <ProviderModelPicker
              environmentId={environmentId}
              disabled={!canOperate || busy}
              activeInstanceId={shownInstanceId}
              model={shownModel}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              isComposerOwned={false}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onInstanceModelChange={pickModel}
            />
          }
        />
        <SettingsRow
          title={gt("Start fresh")}
          description={gt("Begin a new Home conversation. Notes, preferences and crew carry over.")}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canOperate || busy || !home.enabled}
              onClick={() => void startFresh()}
            >
              <T>Start fresh</T>
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

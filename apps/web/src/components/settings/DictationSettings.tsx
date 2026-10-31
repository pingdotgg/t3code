import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type DictationInstallState,
  type DictationState,
  type EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "~/hooks/useSettings";
import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";
import {
  dictationEnvironment,
  useDictationState,
  useReadyDictationEnvironmentIds,
} from "~/state/dictation";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type DictationModel = DictationState["models"][number];

function percent(state: Extract<DictationInstallState, { _tag: "installing" }>): string {
  return state.totalBytes > 0
    ? `${Math.floor((state.receivedBytes / state.totalBytes) * 100)}%`
    : formatBytes(state.receivedBytes);
}

/** Status of the selected model on one environment, and whether Retry applies. */
function activeModelStatus(state: DictationState): {
  readonly label: string;
  readonly failed: boolean;
} {
  const model = state.models.find((candidate) => candidate.id === state.settings.localModel);
  if (!model) return { label: "Unknown model", failed: true };
  if (model.install._tag === "failed")
    return { label: `Failed: ${model.install.message}`, failed: true };
  if (state.runtime._tag === "failed")
    return { label: `Failed: ${state.runtime.message}`, failed: true };
  if (state.runtime._tag === "installing") {
    return { label: `Downloading runtime ${percent(state.runtime)}`, failed: false };
  }
  if (model.install._tag === "installing") {
    return { label: `Downloading ${percent(model.install)}`, failed: false };
  }
  if (model.install._tag === "not-installed") {
    return {
      label:
        state.settings.engine === "off" ? "Downloads when dictation is on" : "Waiting to download",
      failed: false,
    };
  }
  if (state.loadedModel === model.id) return { label: "Loaded", failed: false };
  return { label: state.ready ? "Ready" : "Downloaded", failed: false };
}

/** Short readiness label for an environment in the device picker. */
function readinessLabel(state: DictationState | null): string {
  if (state === null) return "Unavailable";
  if (!state.supported) return "Not supported";
  if (state.ready) return "Ready";
  if (state.settings.engine === "off") return "Off";
  return activeModelStatus(state).label;
}

const modelDetail = (model: DictationModel) =>
  [model.languages, formatBytes(model.downloadBytes), model.note].filter(Boolean).join(" · ");

// Scope model installation to each selected environment.
export function DictationSettingsSection() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig !== null
      ? environment.environmentId
      : null;
  const { state, error } = useDictationState(environmentId);
  // A server from before dictation has no dictation methods, so its subscription fails outright.
  const outdated = environmentId !== null && state === null && error !== null;
  const settings = useScopedSettings((unified) => unified.dictation);
  const updateSettings = useUpdateScopedSettings();
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const unsupported = state?.supported === false || outdated;
  const locked = !canConfigure || projectScope || environmentId === null || unsupported;
  const models = state?.models ?? [];
  const activeModel = models.find((model) => model.id === settings.localModel);
  const languageOptions = activeModel?.languageOptions ?? [];

  return (
    <SettingsSection id="dictation" title="Dictation">
      <SettingsRow
        {...searchableSetting("dictation-engine")}
        serverScoped
        settingKeys={["dictation"]}
        description={
          outdated
            ? "Update T3 Code on this machine to use dictation."
            : unsupported
              ? "This environment's platform has no supported speech model."
              : "Transcribe dictation on this environment with a local speech model. Audio is not sent to any other service."
        }
        control={
          <ScopedSwitch
            settingKeys={["dictation"]}
            checked={settings.engine === "local"}
            disabled={locked}
            aria-label="Dictation"
            onCheckedChange={(checked) =>
              updateSettings({ dictation: { engine: checked ? "local" : "off" } })
            }
          />
        }
      />
      {unsupported ? null : (
        <>
          <SettingsRow
            {...searchableSetting("dictation-model")}
            serverScoped
            settingKeys={["dictation"]}
            description={activeModel ? modelDetail(activeModel) : undefined}
            status={connectedEnvironments.map((target) => (
              <DictationModelStatus
                key={target.environmentId}
                environmentId={target.environmentId}
                label={connectedEnvironments.length > 1 ? target.label : null}
              />
            ))}
            control={
              <Select
                items={models.map((model) => ({ value: model.id, label: model.label }))}
                value={settings.localModel}
                disabled={locked || models.length === 0}
                onValueChange={(value) => {
                  const model = models.find((candidate) => candidate.id === value);
                  if (!model) return;
                  const keepsLanguage =
                    settings.language === "auto" ||
                    model.languageOptions.some((option) => option.code === settings.language);
                  updateSettings({
                    dictation: {
                      localModel: model.id,
                      ...(keepsLanguage ? {} : { language: "auto" }),
                    },
                  });
                }}
              >
                <SelectTrigger size="xs" className="w-40" aria-label="Dictation model">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      <span className="flex w-full items-center justify-between gap-5">
                        <span>{model.label}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {modelDetail(model)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("dictation-language")}
            serverScoped
            settingKeys={["dictation"]}
            control={
              <Select
                items={[
                  { value: "auto", label: "Automatic" },
                  ...languageOptions.map((option) => ({
                    value: option.code,
                    label: option.label,
                  })),
                ]}
                value={languageOptions.length === 0 ? "auto" : settings.language}
                disabled={locked || languageOptions.length === 0}
                onValueChange={(language) => {
                  if (language !== null) updateSettings({ dictation: { language } });
                }}
              >
                <SelectTrigger size="xs" className="w-40" aria-label="Dictation language">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="auto">Automatic</SelectItem>
                  {languageOptions.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {connectedEnvironments.map((target) => (
            <InactiveDictationModels
              key={target.environmentId}
              environmentId={target.environmentId}
              label={connectedEnvironments.length > 1 ? target.label : null}
              selectedModel={settings.localModel}
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

/** The selected model's status on one environment, with Retry after a failed download. */
function DictationModelStatus(props: {
  readonly environmentId: EnvironmentId;
  /** Names the environment when several are selected. */
  readonly label: string | null;
}) {
  const { state } = useDictationState(props.environmentId);
  const canRetry = useAtomValue(dictationEnvironment.install.permissionAtom(props.environmentId));
  const install = useAtomCommand(dictationEnvironment.install, { reportFailure: false });
  if (!state?.supported) return null;
  const status = activeModelStatus(state);
  return (
    <span className="flex items-center gap-2 text-xs">
      <span
        className={cn("tabular-nums", status.failed ? "text-destructive" : "text-muted-foreground")}
      >
        {props.label ? `${props.label}: ${status.label}` : status.label}
      </span>
      {status.failed ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!canRetry}
          onClick={() =>
            void install({
              environmentId: props.environmentId,
              input: { model: state.settings.localModel },
            }).then((result) => {
              if (result._tag === "Failure") {
                toastManager.add({ type: "error", title: "Could not retry the download" });
              }
            })
          }
        >
          Retry
        </Button>
      ) : null}
    </span>
  );
}

function InactiveDictationModels(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly selectedModel: DictationModel["id"];
}) {
  const { state } = useDictationState(props.environmentId);
  const canRemove = useAtomValue(dictationEnvironment.remove.permissionAtom(props.environmentId));
  const remove = useAtomCommand(dictationEnvironment.remove, { reportFailure: false });
  const [removing, setRemoving] = useState<DictationModel["id"] | null>(null);
  if (!state?.supported) return null;
  const inactive = state.models.filter(
    // The environment keeps its own active model even when another environment's
    // selection is shown; removing it would be a no-op on the server.
    (model) =>
      model.install._tag === "installed" &&
      model.id !== props.selectedModel &&
      model.id !== state.settings.localModel,
  );
  if (inactive.length === 0) return null;

  return (
    <SettingsRow
      title={props.label ? `Other downloaded models on ${props.label}` : "Other downloaded models"}
    >
      <ul className="pt-1 pb-2">
        {inactive.map((model) => (
          <li key={model.id} className="flex items-center justify-between gap-3 py-1 text-sm">
            <span>
              {model.label}
              <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                {formatBytes(
                  model.install._tag === "installed"
                    ? model.install.sizeBytes
                    : model.downloadBytes,
                )}
              </span>
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={!canRemove || removing !== null}
              onClick={() => {
                setRemoving(model.id);
                void remove({
                  environmentId: props.environmentId,
                  input: { model: model.id },
                }).then((result) => {
                  setRemoving(null);
                  if (result._tag === "Failure") {
                    toastManager.add({ type: "error", title: `Could not remove ${model.label}` });
                  }
                });
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </SettingsRow>
  );
}

const AUTOMATIC = "automatic";

export function DictationRoutingSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const chosen = useClientSettings((settings) => settings.dictationEnvironmentId);
  const hydrated = useClientSettingsHydrated();
  const updateSettings = updateClientSettings;
  const ready = useReadyDictationEnvironmentIds();

  if (environments.length < 2) return null;

  const options = [
    { value: AUTOMATIC, label: "Automatic" },
    ...environments
      .filter(
        (environment) =>
          ready.includes(environment.environmentId) || environment.environmentId === chosen,
      )
      .map((environment) => ({ value: environment.environmentId, label: environment.label })),
  ];
  const { id, title } = searchableSetting("dictation-environment");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={options.find((option) => option.value === chosen)?.label ?? "Automatic"}
      control={
        <Select
          items={options}
          value={chosen ?? AUTOMATIC}
          disabled={!hydrated}
          onValueChange={(value) => {
            if (value === null) return;
            updateSettings({
              dictationEnvironmentId:
                environments.find((environment) => environment.environmentId === value)
                  ?.environmentId ?? null,
            });
          }}
        >
          <SelectTrigger size="xs" className="w-36" aria-label="Dictation environment">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        The machine that turns this device's dictation into text. Automatic uses the machine that
        owns the thread when its dictation is ready, otherwise another ready machine. Download
        models in Devices. This applies only to this device.
      </p>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.environmentId}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          label={environment.label}
          subtitle={environmentTransportLabel(environment)}
        >
          <DictationReadiness environmentId={environment.environmentId} />
        </EnvironmentRow>
      ))}
    </FoldedSettingsSection>
  );
}

function DictationReadiness(props: { readonly environmentId: EnvironmentId }) {
  const { state } = useDictationState(props.environmentId);
  return <span className="text-xs text-muted-foreground">{readinessLabel(state)}</span>;
}

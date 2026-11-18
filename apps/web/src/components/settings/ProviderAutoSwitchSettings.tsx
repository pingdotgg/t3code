import type {
  EnvironmentId,
  ModelSelection,
  ProviderAutoSwitchMode,
  ProviderAutoSwitchSettings as AutoSwitchSettings,
  ProviderAutoSwitchTrigger,
  ServerProvider,
} from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import { ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSearchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const MODES = [
  { value: "off", label: msg("Off", { $context: "provider auto-switch is turned off" }) },
  { value: "ask", label: msg("Ask me") },
  { value: "route", label: msg("Follow a route") },
] as const satisfies ReadonlyArray<{ value: ProviderAutoSwitchMode; label: unknown }>;

const TRIGGERS = [
  { value: "exhausted", label: msg("Usage limit reached") },
  { value: "session", label: msg("Session usage reaches") },
  { value: "weekly", label: msg("Weekly usage reaches") },
] as const satisfies ReadonlyArray<{ value: ProviderAutoSwitchTrigger; label: unknown }>;

const THRESHOLDS = [50, 60, 70, 75, 80, 85, 90, 95] as const;

/** Settings for moving a thread to another provider or account when its usage runs low. */
export function ProviderAutoSwitchSettings({
  environmentId,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const autoSwitch = settings.providerAutoSwitch;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const update = (patch: Partial<AutoSwitchSettings>) =>
    updateSettings({ providerAutoSwitch: { ...autoSwitch, ...patch } });
  const setRoute = (route: ReadonlyArray<ModelSelection>) => update({ route: [...route] });
  const unused = entries.find(
    (entry) =>
      entry.models.length > 0 &&
      !autoSwitch.route.some((step) => step.instanceId === entry.instanceId),
  );
  const addEntry = () => {
    const model = unused?.models[0]?.slug;
    if (unused === undefined || model === undefined) return;
    setRoute([...autoSwitch.route, { instanceId: unused.instanceId, model }]);
  };

  return (
    <SettingsSection {...setting("provider-auto-switch")}>
      <SettingsRow
        serverScoped
        settingKeys={["providerAutoSwitch"]}
        title={gt("When usage runs low")}
        description={gt(
          "Move the thread to another provider or account at the end of the current turn. Its context goes with it.",
        )}
        control={
          <Select
            items={MODES.map((mode) => ({ value: mode.value, label: m(mode.label) }))}
            value={autoSwitch.mode}
            disabled={readOnly}
            onValueChange={(mode) => mode !== null && update({ mode })}
          >
            <SelectTrigger size="xs" className="w-40" aria-label={gt("Auto-switch mode")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {m(mode.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {autoSwitch.mode === "off" ? null : (
        <SettingsRow
          title={gt("Switch when")}
          description={gt(
            "Percentages need a provider that reports its usage. A usage limit always switches.",
          )}
          control={
            <div className="flex items-center gap-1.5">
              <Select
                items={TRIGGERS.map((trigger) => ({
                  value: trigger.value,
                  label: m(trigger.label),
                }))}
                value={autoSwitch.trigger}
                disabled={readOnly}
                onValueChange={(trigger) => trigger !== null && update({ trigger })}
              >
                <SelectTrigger size="xs" className="w-48" aria-label={gt("Switch trigger")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {TRIGGERS.map((trigger) => (
                    <SelectItem key={trigger.value} value={trigger.value}>
                      {m(trigger.label)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {autoSwitch.trigger === "exhausted" ? null : (
                <Select
                  items={THRESHOLDS.map((value) => ({ value, label: `${value}%` }))}
                  value={autoSwitch.thresholdPercent}
                  disabled={readOnly}
                  onValueChange={(thresholdPercent) =>
                    thresholdPercent !== null && update({ thresholdPercent })
                  }
                >
                  <SelectTrigger size="xs" className="w-20" aria-label={gt("Usage threshold")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {THRESHOLDS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {`${value}%`}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              )}
            </div>
          }
        />
      )}
      {autoSwitch.mode === "route" ? (
        <SettingsRow
          title={gt("Route")}
          description={gt(
            "Tried in order after the thread's current provider. Providers past their limit are skipped.",
          )}
          control={
            readOnly ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={unused === undefined}
                onClick={addEntry}
              >
                <PlusIcon className="size-3" aria-hidden />
                <T>Add step</T>
              </Button>
            )
          }
        >
          {autoSwitch.route.length === 0 ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
              <T>Add at least two steps, such as a second account.</T>
            </p>
          ) : (
            <ol className="flex flex-col gap-1.5 px-3 pb-3 sm:px-4">
              {autoSwitch.route.map((step, index) => (
                <li key={`${step.instanceId}:${step.model}`} className="flex items-center gap-1.5">
                  <span className="w-5 text-end text-xs text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={step.instanceId}
                    model={step.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={getCustomModelOptionsByInstance(
                      settings,
                      providers,
                      step.instanceId,
                      step.model,
                    )}
                    disabled={readOnly}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel={gt("Route step {number}", { number: index + 1 })}
                    getModelDisabledReason={(instanceId, model) =>
                      autoSwitch.route.some(
                        (other, at) =>
                          at !== index && other.instanceId === instanceId && other.model === model,
                      )
                        ? gt("Already in the route")
                        : null
                    }
                    onInstanceModelChange={(instanceId, model) =>
                      setRoute(
                        autoSwitch.route.map((current, at) =>
                          at === index ? pickModelSelection(current, instanceId, model) : current,
                        ),
                      )
                    }
                  />
                  {readOnly ? null : (
                    <>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={index === 0}
                        aria-label={gt("Move step up")}
                        onClick={() => {
                          const route = [...autoSwitch.route];
                          [route[index - 1], route[index]] = [route[index]!, route[index - 1]!];
                          setRoute(route);
                        }}
                      >
                        <ArrowUpIcon aria-hidden />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={gt("Remove step")}
                        onClick={() => setRoute(autoSwitch.route.filter((_, at) => at !== index))}
                      >
                        <XIcon aria-hidden />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}

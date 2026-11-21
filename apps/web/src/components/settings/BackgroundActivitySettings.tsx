import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { SettingsIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { type BackgroundActivityProfile } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import { IntervalSecondsField } from "./IntervalSecondsField";
import { PolicyTooltip, SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: msg("Balanced"),
  performance: msg("Performance"),
  "battery-saver": msg("Battery saver"),
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: msg("Advanced", { $context: "background activity power profile" }),
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced: msg("Pauses probes for idle clients, locked hosts, or low power mode."),
  performance: msg(
    "Allows scoped background probes while any subscribed client remains connected.",
  ),
  "battery-saver": msg("Also pauses background probes when the host or client is on battery."),
};

const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
}> = [
  { key: "pauseWhenHostLocked", label: msg("Pause when host is locked") },
  { key: "pauseWhenHostLowPower", label: msg("Pause on host low power") },
  { key: "pauseWhenClientLowPower", label: msg("Pause on client low power") },
  { key: "pauseWhenOnBattery", label: msg("Pause on battery") },
];

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>Background Activity</T>
          </DialogTitle>
          <DialogDescription>
            <T>Tune the shared power policy and the background intervals that feed it.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset
            disabled={!canWriteSettings}
            className="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
          >
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  <T>Shared policy</T>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <T>Controls whether background work may run after a subscribed interval fires.</T>
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={gt("Shared background policy")}
                >
                  <SelectValue>{m(BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {m(BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced)}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {m(BACKGROUND_ACTIVITY_PROFILE_LABELS.performance)}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {m(BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"])}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {searchableSetting("git-fetch-interval").title}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <T>Refresh remote branch status in the background.</T>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  labels={{
                    decrease: gt("Decrease Git fetch interval"),
                    input: gt("Git fetch interval in seconds"),
                    increase: gt("Increase Git fetch interval"),
                  }}
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { automaticGitFetchInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">
                  <T>seconds</T>
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  <T>Provider health interval</T>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <T>
                    Refresh provider availability, versions, and auth state. Model catalog updates
                    follow Provider update checks.
                  </T>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  labels={{
                    decrease: gt("Decrease provider health interval"),
                    input: gt("Provider health interval in seconds"),
                    increase: gt("Increase provider health interval"),
                  }}
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { providerHealthRefreshInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">
                  <T>seconds</T>
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  <T>Host power monitor</T>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <T>Poll host power state while clients are active.</T>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  labels={{
                    decrease: gt("Decrease active host power interval"),
                    input: gt("Active host power interval in seconds"),
                    increase: gt("Increase active host power interval"),
                  }}
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { hostPowerMonitorActiveInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">
                  <T>seconds</T>
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  <T>Idle host monitor</T>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <T>Poll host power state when no foreground client is active.</T>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  labels={{
                    decrease: gt("Decrease idle host power interval"),
                    input: gt("Idle host power interval in seconds"),
                    increase: gt("Increase idle host power interval"),
                  }}
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { hostPowerMonitorIdleInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">
                  <T>seconds</T>
                </span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-e sm:even:border-e-0"
                >
                  <span className="text-sm font-medium">{m(label)}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={m(label)}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canWriteSettings}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            <T>Reset all</T>
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            <T>Done</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BackgroundActivitySettingsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? gt("Uses custom intervals. Shared policy: {profile}.", {
          profile: m(BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]),
        })
      : m(BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile]);
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["backgroundActivity"]}
      id={searchableSetting("background-activity").id}
      title={
        <span className="inline-flex items-center gap-1.5">
          {searchableSetting("background-activity").title}
          <PolicyTooltip>
            {gt(
              "This shared policy gates background work such as Git refreshes and provider health probes after their individual intervals elapse.",
            )}
          </PolicyTooltip>
        </span>
      }
      description={backgroundActivityDescription}
      resetAction={
        canResetBackgroundActivity ? (
          <SettingResetButton
            ariaLabel={gt("Reset background activity to default")}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          />
        ) : null
      }
      control={
        <>
          <Select
            value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
            onValueChange={(value) => {
              if (value === "advanced") {
                if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                return;
              }
              if (value === "balanced" || value === "performance" || value === "battery-saver") {
                updateSettings(backgroundActivityProfileSettings(value));
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={gt("Background activity profile")}
            >
              <SelectValue>
                {(value: BackgroundActivityProfileOption | null) =>
                  value === null
                    ? gt("Mixed", { $context: "values differ across targets" })
                    : m(BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value])
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="balanced">
                {m(BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced)}
              </SelectItem>
              <SelectItem hideIndicator value="performance">
                {m(BACKGROUND_ACTIVITY_PROFILE_LABELS.performance)}
              </SelectItem>
              <SelectItem hideIndicator value="battery-saver">
                {m(BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"])}
              </SelectItem>
              <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                {isEnvironmentScope
                  ? m(BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced)
                  : gt("Advanced (one environment)")}
              </SelectItem>
            </SelectPopup>
          </Select>
          {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label={gt("Configure advanced background activity")}
                    onClick={() => setBackgroundActivityDialogOpen(true)}
                  >
                    <SettingsIcon className="size-4" />
                  </Button>
                }
              />
              <TooltipPopup side="top">
                <T>Configure background activity</T>
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <BackgroundActivityAdvancedDialog
            open={backgroundActivityDialogOpen && isEnvironmentScope}
            onOpenChange={setBackgroundActivityDialogOpen}
          />
        </>
      }
    />
  );
}

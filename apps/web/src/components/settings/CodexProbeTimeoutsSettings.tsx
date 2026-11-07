import {
  CODEX_PROBE_TIMEOUT_MAX_MS,
  CODEX_PROBE_TIMEOUT_MIN_MS,
  DEFAULT_CODEX_PROBE_TIMEOUTS,
  type CodexProbeTimeouts,
} from "@t3tools/contracts";
import { useState } from "react";
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
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { PolicyTooltip, SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const TIMEOUT_FIELDS = [
  {
    key: "startup",
    title: "App-server startup",
    description: "Handshake, account lookup, and model and skill discovery.",
  },
  {
    key: "skills",
    title: "Skills scan",
    description: "Skills discovery for a thread's folder before it appears in the composer.",
  },
  {
    key: "catalogRefresh",
    title: "Model catalog refresh",
    description: "Wait for the app-server to refresh its shared model catalog.",
  },
  {
    key: "config",
    title: "Config read",
    description: "Read the service tier from the app-server configuration.",
  },
  {
    key: "rateLimits",
    title: "Rate-limit read",
    description: "Read the account's current usage windows.",
  },
  {
    key: "resetCredit",
    title: "Reset-credit redemption",
    description: "Redeem a usage reset credit on the selected account.",
  },
] as const satisfies ReadonlyArray<{
  readonly key: keyof CodexProbeTimeouts;
  readonly title: string;
  readonly description: string;
}>;

const MIN_SECONDS = CODEX_PROBE_TIMEOUT_MIN_MS / 1_000;
const MAX_SECONDS = CODEX_PROBE_TIMEOUT_MAX_MS / 1_000;

const seconds = (milliseconds: number) => Math.round(milliseconds / 1_000);
const milliseconds = (value: number) =>
  Math.min(
    CODEX_PROBE_TIMEOUT_MAX_MS,
    Math.max(CODEX_PROBE_TIMEOUT_MIN_MS, Math.round(value) * 1_000),
  );

function useTimeoutFieldMixed() {
  const { targets } = useSettingsScope();
  const first = targets[0]?.settings.codexProbeTimeouts;
  return (key: keyof CodexProbeTimeouts) =>
    first === undefined
      ? false
      : targets.some((target) => target.settings.codexProbeTimeouts[key] !== first[key]);
}

function CodexProbeTimeoutsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const fieldMixed = useTimeoutFieldMixed();
  const timeouts = settings.codexProbeTimeouts;

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Codex probe timeouts</DialogTitle>
          <DialogDescription>
            How long T3 Code waits for the Codex app-server before treating a probe as failed.
            Longer values tolerate slow account services; shorter values surface a stalled
            app-server sooner.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset
            disabled={!canWriteSettings}
            className="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
          >
            {TIMEOUT_FIELDS.map((field, index) => {
              const mixed = fieldMixed(field.key);
              return (
                <div
                  key={field.key}
                  className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${
                    index > 0 ? "border-t" : ""
                  }`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-medium">{field.title}</div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {field.description}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <NumberField
                      value={mixed ? null : seconds(timeouts[field.key])}
                      min={MIN_SECONDS}
                      max={MAX_SECONDS}
                      step={1}
                      size="sm"
                      className="w-32"
                      onValueChange={(value) => {
                        if (value === null) return;
                        updateSettings({
                          codexProbeTimeouts: { [field.key]: milliseconds(value) },
                        });
                      }}
                    >
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label={`Decrease ${field.title}`} />
                        <NumberFieldInput
                          aria-label={`${field.title} in seconds`}
                          placeholder={mixed ? "Mixed" : undefined}
                        />
                        <NumberFieldIncrement aria-label={`Increase ${field.title}`} />
                      </NumberFieldGroup>
                    </NumberField>
                    <span className="text-xs text-muted-foreground">seconds</span>
                  </div>
                </div>
              );
            })}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => updateSettings({ codexProbeTimeouts: DEFAULT_CODEX_PROBE_TIMEOUTS })}
          >
            Reset to defaults
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CodexProbeTimeoutsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const mixed = useScopedSettingsMixed(["codexProbeTimeouts"]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const timeouts = settings.codexProbeTimeouts;
  const changed = TIMEOUT_FIELDS.some(
    ({ key }) => timeouts[key] !== DEFAULT_CODEX_PROBE_TIMEOUTS[key],
  );
  const summary = mixed
    ? "Mixed across the selected environments"
    : `Startup ${seconds(timeouts.startup)}s · Skills ${seconds(timeouts.skills)}s · Discovery ${seconds(timeouts.catalogRefresh)}s`;

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["codexProbeTimeouts"]}
        {...searchableSetting("codex-probe-timeouts")}
        description={
          <span className="inline-flex items-center gap-1.5">
            {summary}
            <PolicyTooltip>
              These are environment settings. Choose all environments to apply one value across a T3
              Connect network.
            </PolicyTooltip>
          </span>
        }
        resetAction={
          changed ? (
            <span
              inert={!canWriteSettings}
              className={!canWriteSettings ? "opacity-50" : undefined}
            >
              <SettingResetButton
                label="Codex probe timeouts"
                onClick={() => updateSettings({ codexProbeTimeouts: DEFAULT_CODEX_PROBE_TIMEOUTS })}
              />
            </span>
          ) : null
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!canWriteSettings}
            onClick={() => setDialogOpen(true)}
          >
            Configure
          </Button>
        }
      />
      <CodexProbeTimeoutsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}

import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

const SIGNALS = [
  { key: "otlpTracesUrl", label: "Traces", path: "traces" },
  { key: "otlpMetricsUrl", label: "Metrics", path: "metrics" },
  { key: "otlpLogsUrl", label: "Logs", path: "logs" },
] as const;

export function TelemetryExportSettings() {
  const { environment, scope } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.observability);
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const values = { ...saved, ...draft };
  const changed = SIGNALS.some(({ key }) => values[key].trim() !== saved[key]);
  const running = environment?.serverConfig?.observability;

  if (scope.kind !== "environment") {
    return (
      <SettingsSection title="OpenTelemetry export" id="telemetry-export">
        <SettingsScopeNotice target="environment">
          Choose one environment to configure its telemetry exports.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="OpenTelemetry export" id="telemetry-export">
      <form
        className="grid gap-4 px-4 py-4 sm:px-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!environment || saving) return;
          setSaving(true);
          setMessage(null);
          try {
            const result = await updateSettings({
              environmentId: environment.environmentId,
              input: { patch: { observability: values } },
            });
            if (result._tag === "Success") {
              setDraft({});
              setMessage("Saved. Restart the server to apply.");
            }
          } finally {
            setSaving(false);
          }
        }}
      >
        <p className="text-xs text-muted-foreground">
          Send traces, metrics, and logs to an OTLP HTTP receiver. Restart the server to apply.
          Environment variables override these settings.
        </p>
        {SIGNALS.map(({ key, label, path }) => (
          <div key={key} className="grid gap-1.5">
            <Label htmlFor={key}>{label} endpoint</Label>
            <Input
              id={key}
              size="sm"
              type="url"
              pattern="https?://.*"
              title="Enter an HTTP or HTTPS endpoint, or leave empty to disable export."
              placeholder={`http://localhost:4318/v1/${path}`}
              value={values[key]}
              disabled={saving}
              onChange={(event) => {
                setDraft((previous) => ({ ...previous, [key]: event.target.value }));
                setMessage(null);
              }}
            />
            {saved[key] !== (running?.[key] ?? "") && (
              <p className="break-all text-xs text-muted-foreground">
                Running: {running?.[key] || "Disabled"}
              </p>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!changed || saving}
              onClick={() => {
                setDraft({});
                setMessage(null);
              }}
            >
              Discard
            </Button>
            <Button type="submit" size="xs" disabled={!changed || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </SettingsSection>
  );
}

import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
  const differsFromRunning = SIGNALS.some(({ key }) => saved[key] !== (running?.[key] ?? ""));

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
        className="space-y-4 p-4 sm:p-5"
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
              setMessage("Saved. Restart this environment's server to apply changes.");
            }
          } finally {
            setSaving(false);
          }
        }}
      >
        <p className="text-xs text-muted-foreground">
          Send traces, metrics, and logs to an OTLP HTTP receiver from this environment's server.
          Use a full endpoint for each signal. Leave a field empty to disable its saved export.
        </p>
        {SIGNALS.map(({ key, label, path }) => (
          <div key={key} className="space-y-1.5">
            <label htmlFor={key} className="text-sm">
              {label} endpoint
            </label>
            <Input
              id={key}
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
            <p className="break-all text-xs text-muted-foreground">
              Running configuration: {running?.[key] || "Disabled"}
            </p>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          Restart the server after saving. Environment variables and desktop startup configuration
          override these settings, including empty fields. For remote environments, localhost means
          the server's machine. Configured endpoints do not confirm successful delivery.
        </p>
        {differsFromRunning && (
          <p className="text-xs text-muted-foreground">
            Saved endpoints differ from the running configuration. Restart the server to apply them;
            if they still differ, check its startup overrides.
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={!changed || saving}>
            {saving ? "Saving…" : "Save endpoints"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!changed || saving}
            onClick={() => {
              setDraft({});
              setMessage(null);
            }}
          >
            Discard changes
          </Button>
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      </form>
    </SettingsSection>
  );
}

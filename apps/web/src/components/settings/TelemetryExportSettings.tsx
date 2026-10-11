import { useAtomValue } from "@effect/atom-react";
import type { OtlpEndpointCheckResult, OtlpSignal } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

const SIGNALS = [
  { key: "otlpTracesUrl", label: "Traces", signal: "traces" },
  { key: "otlpMetricsUrl", label: "Metrics", signal: "metrics" },
  { key: "otlpLogsUrl", label: "Logs", signal: "logs" },
] as const;

type SignalKey = (typeof SIGNALS)[number]["key"];

/** The latest check for a signal; it describes the field only while `url` is still its value. */
type EndpointCheck = { readonly url: string; readonly result: OtlpEndpointCheckResult | null };

const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

function endpointStatus(url: string, check: EndpointCheck | undefined) {
  if (url === "") return { label: "Off", dot: "bg-muted-foreground/40" };
  if (check?.url !== url) return { label: "Not checked", dot: "bg-muted-foreground/40" };
  const { result } = check;
  if (result === null) return { label: "Checking…", dot: "bg-warning" };
  switch (result._tag) {
    case "Accepted":
      return { label: `Connected · ${Math.round(result.latencyMs)} ms`, dot: "bg-success" };
    case "Rejected":
      return { label: `Rejected · HTTP ${result.status}`, dot: "bg-destructive" };
    case "Unreachable":
      return { label: result.timedOut ? "Timed out" : "Unreachable", dot: "bg-destructive" };
  }
}

export function TelemetryExportSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title="OpenTelemetry export" id="telemetry-export">
        <SettingsScopeNotice target="environment">
          Choose one environment to configure its telemetry exports.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  // Mounts per environment so its saved endpoints are the ones checked on open.
  return <TelemetryExportForm key={environment.environmentId} />;
}

function TelemetryExportForm() {
  const { environment } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.observability);
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const environmentId = environment?.environmentId;
  // Checks need the same grant as saving, so one permission covers the whole form.
  const canEdit = useAtomValue(
    serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId ?? null),
  );
  // Servers from before endpoint checks keep the editor without Test.
  const canCheck =
    canEdit && environment?.serverConfig?.environment.capabilities.otlpEndpointCheck === true;
  // Saved endpoints open as pending; the effect below sends their checks.
  const [checks, setChecks] = useState<Partial<Record<SignalKey, EndpointCheck>>>(() =>
    Object.fromEntries(
      SIGNALS.filter(({ key }) => isHttpUrl(saved[key])).map(({ key }) => [
        key,
        { url: saved[key], result: null },
      ]),
    ),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const checkOtlpEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint);
  const values = { ...saved, ...draft };
  const changedSignals = SIGNALS.filter(({ key }) => values[key].trim() !== saved[key]);
  const changed = changedSignals.length > 0;
  const running = environment?.serverConfig?.observability;

  const sendCheck = async (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!environmentId) return;
    const response = await checkOtlpEndpoint({ environmentId, input: { signal, url } });
    // A newer check for the same field replaces this one.
    setChecks((previous) => {
      if (previous[key]?.url !== url || previous[key].result !== null) return previous;
      const next = { ...previous };
      if (response._tag === "Success") next[key] = { url, result: response.value };
      else delete next[key];
      return next;
    });
  };

  const checkEndpoint = (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!isHttpUrl(url)) return;
    setChecks((previous) => ({ ...previous, [key]: { url, result: null } }));
    void sendCheck(key, signal, url);
  };

  // Sends checks still pending, such as the saved endpoints' when the form opens.
  const sendPendingChecks = useEffectEvent(() => {
    for (const { key, signal } of SIGNALS) {
      const check = checks[key];
      if (check?.result === null) void sendCheck(key, signal, check.url);
    }
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    if (canCheck) sendPendingChecks();
  }, [canCheck]);

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
              input: {
                patch: {
                  observability: Object.fromEntries(
                    changedSignals.map(({ key }) => [key, values[key]]),
                  ),
                },
              },
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
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            This connection lacks permission to change settings on{" "}
            {environment?.label ?? "the selected environment"}.
          </p>
        )}
        {SIGNALS.map(({ key, label, signal }) => {
          const url = values[key].trim();
          const status = canCheck ? endpointStatus(url, checks[key]) : null;
          return (
            <div key={key} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  {status && <ConnectionStatusDot dotClassName={status.dot} />}
                  <Label htmlFor={key}>{label} endpoint</Label>
                </div>
                {status && <span className="text-xs text-muted-foreground">{status.label}</span>}
              </div>
              <div className="flex gap-2">
                <Input
                  id={key}
                  size="sm"
                  type="url"
                  pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
                  title="Enter an HTTP or HTTPS endpoint, or leave empty to disable export."
                  placeholder={`http://localhost:4318/v1/${signal}`}
                  value={values[key]}
                  disabled={saving || !canEdit}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Restoring the saved value drops the draft, so a later save can't resend it
                    // over another client's change.
                    setDraft((previous) => {
                      const next = { ...previous, [key]: value };
                      if (value.trim() === saved[key]) delete next[key];
                      return next;
                    });
                    setMessage(null);
                  }}
                />
                {canCheck && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!isHttpUrl(url) || checks[key]?.result === null}
                    onClick={() => void checkEndpoint(key, signal, url)}
                  >
                    Test
                  </Button>
                )}
              </div>
              {saved[key] !== (running?.[key] ?? "") && (
                <p className="break-all text-xs text-muted-foreground">
                  Running: {running?.[key] || "Disabled"}
                </p>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!changed || saving || !canEdit}
              onClick={() => {
                setDraft({});
                setMessage(null);
                // A tested draft replaced the saved endpoint's status; check the saved one again.
                if (!canCheck) return;
                for (const { key, signal } of SIGNALS) {
                  if (checks[key]?.url !== saved[key]) checkEndpoint(key, signal, saved[key]);
                }
              }}
            >
              Discard
            </Button>
            <Button type="submit" size="xs" disabled={!changed || saving || !canEdit}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </SettingsSection>
  );
}

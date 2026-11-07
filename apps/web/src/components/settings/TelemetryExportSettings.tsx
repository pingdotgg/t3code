import { useAtomValue } from "@effect/atom-react";
import type { OtlpEndpointCheckResult, OtlpSignal, ServerObservability } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { RichMessage, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { type MessageKey, type TranslateFn } from "@t3tools/client-runtime/i18n";
import { useT } from "~/hooks/useI18n";

const SIGNALS = [
  {
    key: "otlpTracesUrl",
    sourceKey: "otlpTracesSource",
    variableKey: "otlpTracesVariable",
    label: "settings.system.telemetry.traces",
    signal: "traces",
  },
  {
    key: "otlpMetricsUrl",
    sourceKey: "otlpMetricsSource",
    variableKey: "otlpMetricsVariable",
    label: "settings.system.telemetry.metrics",
    signal: "metrics",
  },
  {
    key: "otlpLogsUrl",
    sourceKey: "otlpLogsSource",
    variableKey: "otlpLogsVariable",
    label: "settings.system.telemetry.logs",
    signal: "logs",
  },
] as const;

type SignalDescriptor = (typeof SIGNALS)[number];
type SignalKey = SignalDescriptor["key"];

const OVERRIDE_LABELS = {
  environment: "settings.system.telemetry.setByEnv",
  bootstrap: "settings.system.telemetry.setByDesktop",
} as const satisfies Record<string, MessageKey>;

function runningOverride(
  running: ServerObservability | undefined,
  { key, sourceKey, variableKey }: SignalDescriptor,
) {
  const url = running?.[key];
  const source = running?.[sourceKey];
  if (url === undefined || (source !== "environment" && source !== "bootstrap")) return undefined;
  return { url, label: OVERRIDE_LABELS[source], variable: running?.[variableKey] };
}

type EndpointCheck = { readonly url: string; readonly result: OtlpEndpointCheckResult | null };

const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

const inlineCodeTag = (children: string) => <code className="font-mono">{children}</code>;

function endpointStatus(url: string, check: EndpointCheck | undefined, t: TranslateFn) {
  if (url === "")
    return { label: t("settings.system.telemetry.off"), dot: "bg-muted-foreground/40" };
  if (check?.url !== url)
    return { label: t("settings.system.telemetry.notChecked"), dot: "bg-muted-foreground/40" };
  const { result } = check;
  if (result === null) return { label: t("settings.system.telemetry.checking"), dot: "bg-warning" };
  switch (result._tag) {
    case "Accepted":
      return {
        label: t("settings.system.telemetry.connected", { ms: Math.round(result.latencyMs) }),
        dot: "bg-success",
      };
    case "Rejected":
      return {
        label: t("settings.system.telemetry.rejected", { status: result.status }),
        dot: "bg-destructive",
      };
    case "Unreachable":
      return {
        label: result.timedOut
          ? t("settings.system.telemetry.timedOut")
          : t("settings.system.telemetry.unreachable"),
        dot: "bg-destructive",
      };
  }
}

export function TelemetryExportSettings() {
  const t = useT();
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title={t("settings.system.telemetry.title")} id="telemetry-export">
        <SettingsScopeNotice target="environment">
          {t("settings.system.telemetry.chooseEnv")}
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <TelemetryExportForm key={environment.environmentId} />;
}

function TelemetryExportForm() {
  const t = useT();
  const { environment } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.observability);
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const environmentId = environment?.environmentId;
  const canEdit = useAtomValue(
    serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId ?? null),
  );
  const canCheck =
    canEdit && environment?.serverConfig?.environment.capabilities.otlpEndpointCheck === true;
  const running = environment?.serverConfig?.observability;
  const [checks, setChecks] = useState<Partial<Record<SignalKey, EndpointCheck>>>(() =>
    Object.fromEntries(
      SIGNALS.flatMap((descriptor) => {
        const url = runningOverride(running, descriptor)?.url ?? saved[descriptor.key];
        return isHttpUrl(url) ? [[descriptor.key, { url, result: null }]] : [];
      }),
    ),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const checkOtlpEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint);
  const values = { ...saved, ...draft };
  const changedSignals = SIGNALS.filter(({ key }) => values[key].trim() !== saved[key]);
  const changed = changedSignals.length > 0;

  const sendCheck = async (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!environmentId) return;
    const response = await checkOtlpEndpoint({ environmentId, input: { signal, url } });
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

  const sendPendingChecks = useEffectEvent(() => {
    for (const { key, signal } of SIGNALS) {
      const check = checks[key];
      if (check?.result === null) void sendCheck(key, signal, check.url);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends pending endpoint check requests once the environment can run them
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    if (canCheck) sendPendingChecks();
  }, [canCheck]);

  return (
    <SettingsSection title={t("settings.system.telemetry.title")} id="telemetry-export">
      <form
        className="grid gap-4 px-4 py-4 sm:px-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!environment || saving) return;
          setSaving(true);
          setMessage(null);
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
          setSaving(false);
          if (result._tag === "Success") {
            setDraft({});
            setMessage(t("settings.system.telemetry.saved"));
          }
        }}
      >
        <p className="text-xs text-muted-foreground">{t("settings.system.telemetry.intro")}</p>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            {t("settings.system.layout.noPermission", {
              label: environment?.label ?? t("settings.system.layout.selectedEnvironment"),
            })}
          </p>
        )}
        {SIGNALS.map((descriptor) => {
          const { key, signal } = descriptor;
          const label = t(descriptor.label);
          const override = runningOverride(running, descriptor);
          const url = override?.url ?? values[key].trim();
          const check = canCheck ? endpointStatus(url, checks[key], t) : null;
          const status = override
            ? {
                label: check ? `${t(override.label)} · ${check.label}` : t(override.label),
                dot: check?.dot ?? "bg-muted-foreground/40",
              }
            : check;
          return (
            <div key={key} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  {status && <ConnectionStatusDot dotClassName={status.dot} />}
                  <Label htmlFor={key}>{t("settings.system.telemetry.endpoint", { label })}</Label>
                </div>
                {status && <span className="text-xs text-muted-foreground">{status.label}</span>}
              </div>
              <div className="flex gap-2">
                <Input
                  id={key}
                  size="sm"
                  type="url"
                  pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
                  title={t("settings.system.telemetry.urlTitle")}
                  placeholder={`http://localhost:4318/v1/${signal}`}
                  value={values[key]}
                  disabled={saving || !canEdit}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Clear restored drafts so later saves cannot overwrite another client's changes.
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
                    {t("settings.system.telemetry.test")}
                  </Button>
                )}
              </div>
              {(saved[key] !== (running?.[key] ?? "") || override?.variable) && (
                <p className="break-all text-xs text-muted-foreground">
                  <RichMessage
                    message={t(
                      override?.variable
                        ? "settings.system.telemetry.runningFrom"
                        : "settings.system.telemetry.running",
                      {
                        value: running?.[key] || t("settings.system.telemetry.disabled"),
                        variable: override?.variable ?? "",
                      },
                    )}
                    tags={{ code: inlineCodeTag }}
                  />
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
                if (!canCheck) return;
                for (const descriptor of SIGNALS) {
                  const { key, signal } = descriptor;
                  if (runningOverride(running, descriptor)) continue;
                  if (checks[key]?.url !== saved[key]) checkEndpoint(key, signal, saved[key]);
                }
              }}
            >
              {t("settings.system.telemetry.discard")}
            </Button>
            <Button type="submit" size="xs" disabled={!changed || saving || !canEdit}>
              {saving ? t("settings.system.telemetry.saving") : t("settings.system.telemetry.save")}
            </Button>
          </div>
        </div>
      </form>
    </SettingsSection>
  );
}

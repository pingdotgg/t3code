import {
  AGENT_SESSION_IMPORT_BOUNDS,
  DEFAULT_SERVER_SETTINGS,
  type AgentSessionImportSettings as AgentSessionImportLimits,
} from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type LimitKey = keyof AgentSessionImportLimits;

const DEFAULTS = DEFAULT_SERVER_SETTINGS.agentSessionImport;

const LIMITS: ReadonlyArray<{
  readonly key: LimitKey;
  readonly id: Parameters<typeof searchableSetting>[0];
  readonly title: string;
  readonly description: string;
  readonly unit: string;
  readonly step?: number;
  readonly offLabel?: string;
}> = [
  {
    key: "windowDays",
    id: "agent-session-import-window",
    title: "Time window",
    description: "Only conversations active within this many days are imported.",
    unit: "days",
    offLabel: "All history",
  },
  {
    key: "conversationsPerRun",
    id: "agent-session-import-conversations",
    title: "Conversations per run",
    description: "Most conversations imported per project each time you import.",
    unit: "conversations",
  },
  {
    key: "recordsPerConversation",
    id: "agent-session-import-records",
    title: "Records per conversation",
    description:
      "Transcript lines read from one conversation, including tool activity; longer ones are skipped.",
    unit: "records",
    step: 1000,
  },
  {
    key: "messagesPerThread",
    id: "agent-session-import-messages",
    title: "Messages per thread",
    description:
      "Keeps the first prompt plus the latest messages; threads already imported are not changed.",
    unit: "messages",
    offLabel: "Full history",
  },
  {
    key: "scanBudgetMiB",
    id: "agent-session-import-scan-budget",
    title: "Scan budget",
    description:
      "History data read from each agent to find where conversations ran; raise it when projects are missing.",
    unit: "MiB",
  },
];

function isRaised(settings: AgentSessionImportLimits) {
  return LIMITS.some(({ key }) => {
    const value = settings[key];
    return value === null || value > DEFAULTS[key]!;
  });
}

function isCustom(settings: AgentSessionImportLimits) {
  return LIMITS.some(({ key }) => settings[key] !== DEFAULTS[key]);
}

function LimitControl({
  label,
  unit,
  value,
  fallback,
  bounds,
  step = 1,
  offLabel,
  mixed,
  onChange,
}: {
  label: string;
  unit: string;
  value: number | null;
  fallback: number;
  bounds: { readonly minimum: number; readonly maximum: number };
  step?: number | undefined;
  offLabel?: string | undefined;
  mixed: boolean;
  onChange: (value: number | null, onFailed: () => void) => void;
}) {
  const [draft, setDraft] = useState(value);
  // `undefined` forces the next render to adopt the stored value after a failed save.
  const [savedValue, setSavedValue] = useState<number | null | undefined>(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={bounds.minimum}
          max={bounds.maximum}
          step={step}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const rounded = Math.min(bounds.maximum, Math.max(bounds.minimum, Math.round(next)));
              setDraft(rounded);
              if (mixed || rounded !== value) onChange(rounded, () => setSavedValue(undefined));
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput
              aria-label={`${label} in ${unit}`}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
              // Base UI commits on blur but not on Enter; refocus so keyboard users stay put.
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const input = event.currentTarget;
                input.blur();
                input.focus();
              }}
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {unit}
            </span>
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">{offLabel}</span>
      )}
      {offLabel !== undefined && (
        <Switch
          aria-label={`Limit ${label}`}
          checked={value !== null}
          onCheckedChange={(enabled) => onChange(enabled ? fallback : null, () => {})}
        />
      )}
    </div>
  );
}

export function AgentSessionImportSettings() {
  const { connectedEnvironments, targets, scope } = useSettingsScope();
  const settings = useScopedSettings((current) => current.agentSessionImport);
  const updateSettings = useUpdateScopedSettings();

  if (scope.kind === "project" || scope.kind === "checkout" || connectedEnvironments.length === 0)
    return null;

  const supportedEnvironments = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.agentSessionImportSettings === true,
  );
  const supported = supportedEnvironments.length === connectedEnvironments.length;
  const { id, title } = searchableSetting("agent-session-import");

  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={
        supported
          ? targets.some((target) => isCustom(target.settings.agentSessionImport))
            ? "Custom limits"
            : "Default limits"
          : null
      }
    >
      {supported ? (
        <>
          <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
            Limits for importing Claude Code, Codex, and Pi conversations. New limits apply to
            conversations that are not imported yet.
          </p>
          {LIMITS.map((limit) => {
            const { key } = limit;
            const status = targets.some(
              (target) => target.settings.agentSessionImport[key] !== settings[key],
            )
              ? "Mixed across selected machines"
              : undefined;
            return (
              <SettingsRow
                key={key}
                {...searchableSetting(limit.id)}
                title={limit.title}
                description={limit.description}
                status={status}
                serverScoped
                managedPaths={[`agentSessionImport.${key}`]}
                resetAction={
                  status !== undefined || settings[key] !== DEFAULTS[key] ? (
                    <SettingResetButton
                      label={limit.title}
                      onClick={() =>
                        updateSettings({ agentSessionImport: { [key]: DEFAULTS[key] } })
                      }
                    />
                  ) : null
                }
                control={
                  <LimitControl
                    label={limit.title}
                    unit={limit.unit}
                    value={settings[key]}
                    fallback={DEFAULTS[key]!}
                    bounds={AGENT_SESSION_IMPORT_BOUNDS[key]}
                    step={limit.step}
                    offLabel={limit.offLabel}
                    mixed={status !== undefined}
                    onChange={(value, onFailed) =>
                      updateSettings({ agentSessionImport: { [key]: value } }, { onFailed })
                    }
                  />
                }
              />
            );
          })}
          {targets.some((target) => isRaised(target.settings.agentSessionImport)) && (
            <div className="p-3 sm:p-4">
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertDescription>
                  Higher limits make scans and imports take longer and use more memory on the
                  computer running them.
                </AlertDescription>
              </Alert>
            </div>
          )}
        </>
      ) : (
        <SettingsScopeNotice
          inline
          target="environment"
          targetId={id}
          eligibleEnvironmentIds={supportedEnvironments.map(
            (environment) => environment.environmentId,
          )}
        >
          Update the selected environments to change import limits, or choose a machine that
          supports them.
        </SettingsScopeNotice>
      )}
    </FoldedSettingsSection>
  );
}

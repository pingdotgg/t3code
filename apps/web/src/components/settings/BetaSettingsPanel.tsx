import { useEffect, useState } from "react";

import {
  useClientSettings,
  usePrimarySettings,
  useSidebarV2Enabled,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { parseSentryDsn } from "@t3tools/shared/sentryAgentMonitoring";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const AUTO_SETTLE_MIN_DAYS = 1;
const AUTO_SETTLE_MAX_DAYS = 90;
const AUTO_SETTLE_DEFAULT_DAYS = 3;
const REDACTED_SENTRY_DSN = "••••••••••••••••";

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      min={AUTO_SETTLE_MIN_DAYS}
      max={AUTO_SETTLE_MAX_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= AUTO_SETTLE_MIN_DAYS &&
          parsed <= AUTO_SETTLE_MAX_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

function SentryAgentMonitoringSettings() {
  const monitoring = usePrimarySettings((settings) => settings.observability.sentryAgentMonitoring);
  const updateSettings = useUpdatePrimarySettings();
  const [dsnDraft, setDsnDraft] = useState(monitoring.dsnRedacted ? REDACTED_SENTRY_DSN : "");
  const validDsn = parseSentryDsn(dsnDraft) !== null;
  const showingStoredDsn = monitoring.dsnRedacted && dsnDraft === REDACTED_SENTRY_DSN;
  const sentrySetting = searchableSetting("sentry-agent-monitoring");

  useEffect(() => {
    setDsnDraft((current) => {
      if (monitoring.dsnRedacted) return REDACTED_SENTRY_DSN;
      return current === REDACTED_SENTRY_DSN ? "" : current;
    });
  }, [monitoring.dsnRedacted]);

  return (
    <SettingsRow
      id={sentrySetting.id}
      title={<span className="text-purple-700 dark:text-purple-300">{sentrySetting.title}</span>}
      className="border border-purple-500/20 bg-purple-500/4 dark:border-purple-400/20 dark:bg-purple-500/6"
      description="Send one metadata-only trace for each settled agent turn to your own Sentry project. Includes provider, model, duration, token and tool counts, cost when available, completion state, and normalized errors. Prompts, responses, reasoning, code, diffs, paths, and raw provider events are never sent."
      status={
        <span className="text-purple-700/75 dark:text-purple-300/75">
          {monitoring.enabled
            ? "Restart the server after enabling or replacing the DSN. Turning this off stops future exports immediately."
            : monitoring.dsnRedacted
              ? "DSN stored securely. Monitoring is off."
              : "Off by default."}
        </span>
      }
      control={
        <Switch
          className="data-checked:bg-purple-600 focus-visible:ring-purple-500 dark:data-checked:bg-purple-500"
          checked={monitoring.enabled}
          onCheckedChange={(checked) =>
            updateSettings({
              observability: {
                sentryAgentMonitoring: { enabled: Boolean(checked) },
              },
            })
          }
          aria-label="Enable Sentry agent monitoring"
        />
      }
    >
      {monitoring.enabled ? (
        <div className="mt-3 grid gap-2 border-t border-purple-500/15 py-3 sm:grid-cols-[minmax(0,1fr)_auto] dark:border-purple-400/15">
          <div className="space-y-1">
            <Input
              className="has-focus-visible:border-purple-500 has-focus-visible:ring-purple-500/20 dark:has-focus-visible:border-purple-400 dark:has-focus-visible:ring-purple-400/20"
              type="password"
              value={dsnDraft}
              onChange={(event) => setDsnDraft(event.target.value)}
              onFocus={() => {
                if (showingStoredDsn) setDsnDraft("");
              }}
              onBlur={() => {
                if (monitoring.dsnRedacted && dsnDraft.length === 0) {
                  setDsnDraft(REDACTED_SENTRY_DSN);
                }
              }}
              placeholder="https://public-key@o0.ingest.sentry.io/project-id"
              autoComplete="off"
              spellCheck={false}
              aria-label="Sentry DSN"
            />
            <p className="text-xs text-purple-700/65 dark:text-purple-300/65">
              Find the DSN in Sentry under Project Settings → Client Keys (DSN).
            </p>
          </div>
          <div className="flex items-start gap-2">
            {monitoring.dsnRedacted ? (
              <Button
                variant="outline"
                className="border-purple-500/25 text-purple-700 hover:bg-purple-500/8 dark:border-purple-400/25 dark:text-purple-300 dark:hover:bg-purple-400/8"
                onClick={() =>
                  updateSettings({
                    observability: {
                      sentryAgentMonitoring: {
                        enabled: false,
                        dsn: "",
                        dsnRedacted: false,
                      },
                    },
                  })
                }
              >
                Remove
              </Button>
            ) : null}
            <Button
              className="border-purple-600 bg-purple-600 text-white shadow-purple-600/24 hover:bg-purple-600/90 dark:border-purple-500 dark:bg-purple-500 dark:shadow-purple-500/24 dark:hover:bg-purple-500/90"
              disabled={!validDsn}
              onClick={() => {
                if (!validDsn) return;
                updateSettings({
                  observability: {
                    sentryAgentMonitoring: {
                      dsn: dsnDraft.trim(),
                      dsnRedacted: false,
                    },
                  },
                });
                if (monitoring.dsnRedacted) setDsnDraft(REDACTED_SENTRY_DSN);
              }}
            >
              {showingStoredDsn ? "DSN saved" : monitoring.dsnRedacted ? "Replace DSN" : "Save DSN"}
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useSidebarV2Enabled();
  const sidebarAutoSettleAfterDays = useClientSettings(
    (settings) => settings.sidebarAutoSettleAfterDays,
  );
  const planModeEnabled = useClientSettings((settings) => settings.planModeEnabled);
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SentryAgentMonitoringSettings />
        <SettingsRow
          {...searchableSetting("sidebar-v2")}
          description="One flat thread list in creation order. Active work renders as rich cards; settled threads collapse to compact rows. Settling requires an up-to-date server — on older servers threads simply stay active. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              // Touching the switch pins the choice, so a nightly build that
              // defaults v2 on does not flip it back after the user opts out.
              onCheckedChange={(checked) =>
                updateSettings({
                  sidebarV2Enabled: Boolean(checked),
                  sidebarV2ConfiguredByUser: true,
                })
              }
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
        {sidebarV2Enabled ? (
          <>
            <SettingsRow
              title={searchableSetting("auto-settle-inactive-threads").title}
              description="Threads with no activity for this long settle automatically. Threads on merged or closed PRs always settle."
              control={
                <Switch
                  checked={sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                title="Days of inactivity before auto-settle"
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
          </>
        ) : null}
        <SettingsRow
          {...searchableSetting("restore-plan-mode")}
          description="Legacy feature. Brings back the Build/Plan toggle in the composer along with the /plan and /default commands and the Shift+Tab shortcut. While off, every thread runs in build mode."
          control={
            <Switch
              checked={planModeEnabled}
              onCheckedChange={(checked) => updateSettings({ planModeEnabled: Boolean(checked) })}
              aria-label="Restore plan mode (legacy)"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

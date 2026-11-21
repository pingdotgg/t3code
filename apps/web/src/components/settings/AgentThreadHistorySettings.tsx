import {
  AGENT_THREAD_HISTORY_RECENT_TURNS_MAX,
  type AgentThreadHistoryAccess,
  DEFAULT_SERVER_SETTINGS,
} from "@lathe/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const AGENT_THREAD_HISTORY_ACCESS_LABELS: Record<AgentThreadHistoryAccess, string> = {
  off: "Off",
  referenced: "Referenced threads",
  project: "This project",
  environment: "All projects",
};
const AGENT_THREAD_HISTORY_ACCESS_OPTIONS = [
  "off",
  "referenced",
  "project",
  "environment",
] as const;
function isAgentThreadHistoryAccess(value: string | null): value is AgentThreadHistoryAccess {
  return (
    value !== null && (AGENT_THREAD_HISTORY_ACCESS_OPTIONS as readonly string[]).includes(value)
  );
}
const AGENT_THREAD_HISTORY_RECENT_TURNS_OPTIONS = Array.from(
  { length: AGENT_THREAD_HISTORY_RECENT_TURNS_MAX + 1 },
  (_, turns) => String(turns),
);

/** Fork: how much of other threads agents may read through the Lathe MCP thread tools. */
export function AgentThreadHistorySettings() {
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedThreadHistory = useScopedSettingsMixed(["agentThreadHistoryAccess"]);
  const mixedRecentTurns = useScopedSettingsMixed(["agentThreadHistoryRecentTurns"]);
  const unavailable = connectedEnvironments.length === 0;

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["agentThreadHistoryAccess"]}
        mixed={mixedThreadHistory}
        {...searchableSetting("agent-thread-history")}
        description="Lets agents read other threads to continue their work. Turning it on applies from a thread's next session."
        resetAction={
          settings.agentThreadHistoryAccess !== DEFAULT_SERVER_SETTINGS.agentThreadHistoryAccess ? (
            <SettingResetButton
              ariaLabel="Reset default thread history access to default"
              onClick={() =>
                updateSettings({
                  agentThreadHistoryAccess: DEFAULT_SERVER_SETTINGS.agentThreadHistoryAccess,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={mixedThreadHistory ? null : settings.agentThreadHistoryAccess}
            onValueChange={(value) => {
              if (isAgentThreadHistoryAccess(value))
                updateSettings({ agentThreadHistoryAccess: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Agent thread history">
              <SelectValue>
                {(value: string | null) =>
                  isAgentThreadHistoryAccess(value)
                    ? AGENT_THREAD_HISTORY_ACCESS_LABELS[value]
                    : unavailable
                      ? "Unavailable"
                      : "Mixed"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AGENT_THREAD_HISTORY_ACCESS_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {AGENT_THREAD_HISTORY_ACCESS_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["agentThreadHistoryRecentTurns"]}
        mixed={mixedRecentTurns}
        {...searchableSetting("agent-thread-history-recent-turns")}
        description="How many of a thread's latest turns an agent reads in detail. Earlier turns are reduced to one-line outcomes."
        resetAction={
          settings.agentThreadHistoryRecentTurns !==
          DEFAULT_SERVER_SETTINGS.agentThreadHistoryRecentTurns ? (
            <SettingResetButton
              ariaLabel="Reset default recent turns to default"
              onClick={() =>
                updateSettings({
                  agentThreadHistoryRecentTurns:
                    DEFAULT_SERVER_SETTINGS.agentThreadHistoryRecentTurns,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={mixedRecentTurns ? null : String(settings.agentThreadHistoryRecentTurns)}
            onValueChange={(value) => {
              if (value !== null && AGENT_THREAD_HISTORY_RECENT_TURNS_OPTIONS.includes(value))
                updateSettings({ agentThreadHistoryRecentTurns: Number(value) });
            }}
          >
            <SelectTrigger size="sm" aria-label="Recent turns in full">
              <SelectValue>
                {(value: string | null) =>
                  value !== null ? value : unavailable ? "Unavailable" : "Mixed"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AGENT_THREAD_HISTORY_RECENT_TURNS_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

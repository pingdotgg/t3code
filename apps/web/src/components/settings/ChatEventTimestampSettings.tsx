import { type ChatEventTimestampStyle, DEFAULT_UNIFIED_SETTINGS } from "@lathe/contracts/settings";

import { formatChatEventTimestamp } from "../../chatEventTimestamps";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const STYLE_LABELS: Record<ChatEventTimestampStyle, string> = {
  time: "Time",
  "date-time": "Date and time",
  iso: "ISO",
};
const STYLES = Object.keys(STYLE_LABELS) as ChatEventTimestampStyle[];

/** Fork setting: always show local event times in the chat timeline. */
export function ChatEventTimestampSettings() {
  const enabled = useScopedSettings((settings) => settings.chatEventTimestampsEnabled);
  const style = useScopedSettings((settings) => settings.chatEventTimestampStyle);
  const seconds = useScopedSettings((settings) => settings.chatEventTimestampSeconds);
  const timestampFormat = useScopedSettings((settings) => settings.timestampFormat);
  const updateSettings = useUpdateScopedSettings();
  const nowMinute = useNowMinute();
  const example = formatChatEventTimestamp(`${nowMinute}:00.000Z`, timestampFormat, {
    style,
    seconds,
  });

  return (
    <>
      <SettingsRow
        {...searchableSetting("chat-event-timestamps")}
        description="Always show the local time of messages, tool calls, and finished runs in the chat, instead of only on hover."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => updateSettings({ chatEventTimestampsEnabled: checked })}
            aria-label="Event timestamps"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("chat-event-timestamp-style")}
        description={`The clock follows Time format. Right now this reads ${example}.`}
        resetAction={
          style !== DEFAULT_UNIFIED_SETTINGS.chatEventTimestampStyle ? (
            <SettingResetButton
              ariaLabel="Reset event timestamp style to default"
              onClick={() =>
                updateSettings({
                  chatEventTimestampStyle: DEFAULT_UNIFIED_SETTINGS.chatEventTimestampStyle,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={style}
            disabled={!enabled}
            onValueChange={(value) => {
              const next = STYLES.find((candidate) => candidate === value);
              if (next) updateSettings({ chatEventTimestampStyle: next });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Event timestamp style">
              <SelectValue>{STYLE_LABELS[style]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {STYLES.map((candidate) => (
                <SelectItem key={candidate} hideIndicator value={candidate}>
                  {STYLE_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("chat-event-timestamp-seconds")}
        description="Include seconds in event timestamps."
        resetAction={
          seconds !== DEFAULT_UNIFIED_SETTINGS.chatEventTimestampSeconds ? (
            <SettingResetButton
              ariaLabel="Reset event timestamp seconds to default"
              onClick={() =>
                updateSettings({
                  chatEventTimestampSeconds: DEFAULT_UNIFIED_SETTINGS.chatEventTimestampSeconds,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={seconds}
            disabled={!enabled}
            onCheckedChange={(checked) => updateSettings({ chatEventTimestampSeconds: checked })}
            aria-label="Show seconds in event timestamps"
          />
        }
      />
    </>
  );
}

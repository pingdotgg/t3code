import { type ProxyLedgerSummaryStyle, DEFAULT_UNIFIED_SETTINGS } from "@lathe/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const STYLE_LABELS: Record<ProxyLedgerSummaryStyle, string> = {
  rings: "Rings",
  meters: "Meters",
};
const STYLES = Object.keys(STYLE_LABELS) as ProxyLedgerSummaryStyle[];

/** Fork setting: how the Iris ledger summarises each account's windows on its row. */
export function ProxyLedgerSummarySettings() {
  const style = useScopedSettings((settings) => settings.proxyLedgerSummaryStyle);
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("gateway-account-summary")}
      description="How each gateway account's session, weekly, and model windows are summarised on its row. Rings nest the windows in one small gauge; meters show them side by side."
      resetAction={
        style !== DEFAULT_UNIFIED_SETTINGS.proxyLedgerSummaryStyle ? (
          <SettingResetButton
            ariaLabel="Reset gateway account summary to default"
            onClick={() =>
              updateSettings({
                proxyLedgerSummaryStyle: DEFAULT_UNIFIED_SETTINGS.proxyLedgerSummaryStyle,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={style}
          onValueChange={(value) => {
            const next = STYLES.find((candidate) => candidate === value);
            if (next) updateSettings({ proxyLedgerSummaryStyle: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Gateway account summary">
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
  );
}

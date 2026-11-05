import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function UsageAppearanceSection() {
  const { isReady, usageDisplay, setUsageDisplay } = useAppearancePreferences();

  return (
    <SettingsSection title="Usage meters">
      <SettingsSwitchRow
        disabled={!isReady}
        icon="chart.bar.xaxis"
        label="Show % used"
        subtitle="Count usage limits up from 0% instead of down from 100%, in the app and its widgets."
        value={usageDisplay === "used"}
        onValueChange={(value) => setUsageDisplay(value ? "used" : "left")}
      />
    </SettingsSection>
  );
}

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useAccessibilitySupport } from "../../hooks/useAccessibilitySupport";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AccessibilitySettings() {
  const mode = useClientSettings((settings) => settings.accessibilitySupport);
  const enabled = useAccessibilitySupport();
  const updateSettings = useUpdateClientSettings();
  const options = [
    { value: "auto", label: "Auto" },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ] as const;
  return (
    <SettingsSection id="accessibility" title="Accessibility">
      <SettingsRow
        {...searchableSetting("accessibility-support")}
        description={`Add screen reader navigation hints on this device. Auto follows desktop screen reader detection; in a browser, choose On. Currently ${enabled ? "on" : "off"}. Keyboard navigation and labels are always available.`}
        control={
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value !== "auto" && value !== "on" && value !== "off") return;
              void updateSettings({ accessibilitySupport: value }).catch(() => {
                toastManager.add({ type: "error", title: "Could not save accessible mode" });
              });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Accessible mode">
              <SelectValue>{options.find((option) => option.value === mode)?.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

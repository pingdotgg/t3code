import { DEFAULT_SERVER_SETTINGS, PreviewBrowserMode } from "@t3tools/contracts";

import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

const LABELS: Record<PreviewBrowserMode, string> = {
  native: "T3 native (fast)",
  xvfb: "Chrome (slow)",
};

export function PreviewBrowserModeSetting() {
  const setting = useSearchableSetting();
  const mode = useScopedSettings((settings) => settings.previewBrowserMode);
  const mixed = useScopedSettingsMixed(["previewBrowserMode"]);
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      serverScoped
      settingKeys={["previewBrowserMode"]}
      {...setting("preview-browser-mode")}
      description="The server's browser for preview tabs. Chrome (slow) is full Chrome, for pages that fail in T3 native. Platforms with no Chrome for Testing build run T3 native. Switching closes server browser tabs."
      resetAction={
        mode !== DEFAULT_SERVER_SETTINGS.previewBrowserMode ? (
          <SettingResetButton
            ariaLabel="Reset preview browser to default"
            onClick={() =>
              updateSettings({ previewBrowserMode: DEFAULT_SERVER_SETTINGS.previewBrowserMode })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : mode}
          onValueChange={(value) => {
            const next = PreviewBrowserMode.literals.find((literal) => literal === value);
            if (next !== undefined) updateSettings({ previewBrowserMode: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Preview browser">
            <SelectValue>
              {(value: PreviewBrowserMode | null) => (value === null ? "Mixed" : LABELS[value])}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PreviewBrowserMode.literals.map((literal) => (
              <SelectItem hideIndicator key={literal} value={literal}>
                {LABELS[literal]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

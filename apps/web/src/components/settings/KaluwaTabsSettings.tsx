// Fork: the "Titlebar tabs" section of Settings > Appearance.
import { useGT } from "gt-react";

import { KaluwaTabsSettingsRows } from "./KaluwaTabsSettingsRows";
import { SettingsSection } from "./settingsLayout";

export function KaluwaTabsSettings() {
  const gt = useGT();
  return (
    <SettingsSection id="kaluwa-tabs" title={gt("Titlebar tabs")}>
      <KaluwaTabsSettingsRows />
    </SettingsSection>
  );
}

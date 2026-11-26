// Fork: mounts Kaluwa's theme studio above the app shells, like the theme editor, so it stays
// open across navigation. Its settings rows save for this device, as on the Appearance page.
import { lazy, Suspense } from "react";

import { IS_KALUWA_BUILD } from "../../kaluwa/kaluwaLook";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import type { SettingsScopeSearch } from "../settings/settingsScope";
import { useKaluwaStudioPanelStore } from "./kaluwaStudioPanelStore";

const KaluwaThemeStudioPanel = lazy(() =>
  import("./KaluwaThemeStudioPanel").then((module) => ({
    default: module.KaluwaThemeStudioPanel,
  })),
);

const ALL_PROJECTS: SettingsScopeSearch = {};

export function KaluwaThemeStudioHost() {
  const open = useKaluwaStudioPanelStore((store) => store.open);
  if (!IS_KALUWA_BUILD || !open) return null;
  return (
    <Suspense fallback={null}>
      <SettingsScopeProvider search={ALL_PROJECTS} onChange={() => {}} deviceOnly>
        <KaluwaThemeStudioPanel />
      </SettingsScopeProvider>
    </Suspense>
  );
}

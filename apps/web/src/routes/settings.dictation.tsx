import { createFileRoute } from "@tanstack/react-router";

import { DictationSettingsPanel } from "../components/settings/DictationSettingsPanel";

function SettingsDictationRoute() {
  return <DictationSettingsPanel />;
}

export const Route = createFileRoute("/settings/dictation")({
  component: SettingsDictationRoute,
});

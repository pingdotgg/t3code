import { createFileRoute } from "@tanstack/react-router";

import { VoiceSettingsPanel } from "../components/settings/VoiceSettingsPanel";

function SettingsVoiceRoute() {
  return <VoiceSettingsPanel />;
}

export const Route = createFileRoute("/settings/voice")({
  component: SettingsVoiceRoute,
});

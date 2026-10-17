import { createFileRoute } from "@tanstack/react-router";

import { VoiceSettingsPanel } from "../components/settings/VoiceSettingsPanel";

export const Route = createFileRoute("/settings/voice")({
  component: VoiceSettingsPanel,
});

import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";

export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsSettingsPanel,
});

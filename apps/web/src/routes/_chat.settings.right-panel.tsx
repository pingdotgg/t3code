import { createFileRoute } from "@tanstack/react-router";

import { RightPanelMenuSettingsPanel } from "../fork/rightPanelMenu/RightPanelMenuSettings";

export const Route = createFileRoute("/_chat/settings/right-panel")({
  component: RightPanelMenuSettingsPanel,
});

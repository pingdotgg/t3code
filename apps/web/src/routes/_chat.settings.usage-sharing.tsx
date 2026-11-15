import { createFileRoute } from "@tanstack/react-router";

import { UsageSharingSettingsPanel } from "../components/settings/UsageSharingSettingsPanel";

export const Route = createFileRoute("/_chat/settings/usage-sharing")({
  component: UsageSharingSettingsPanel,
});

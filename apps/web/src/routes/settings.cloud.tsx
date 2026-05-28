import { createFileRoute } from "@tanstack/react-router";

import { CloudSettingsPanel } from "../components/settings/CloudSettings";

export const Route = createFileRoute("/settings/cloud")({
  component: CloudSettingsPanel,
});

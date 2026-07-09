import { createFileRoute } from "@tanstack/react-router";

import { LinearSettingsPanel } from "../components/settings/LinearSettings";

export const Route = createFileRoute("/settings/linear")({
  component: LinearSettingsPanel,
});

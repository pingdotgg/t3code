import { createFileRoute } from "@tanstack/react-router";

import { ComputerUseSettingsPanel } from "../components/settings/ComputerUseSettings";

export const Route = createFileRoute("/_chat/settings/computer-use")({
  component: ComputerUseSettingsPanel,
});

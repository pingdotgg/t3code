import { createFileRoute } from "@tanstack/react-router";

import { ComputerUseSettings } from "../components/settings/ComputerUseSettings";

export const Route = createFileRoute("/settings/computer-use")({
  component: ComputerUseSettings,
});

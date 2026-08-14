import { createFileRoute } from "@tanstack/react-router";

import { ComputerHistorySettings } from "../components/settings/ComputerHistorySettings";

export const Route = createFileRoute("/settings/computer-history")({
  component: ComputerHistorySettings,
});

import { createFileRoute } from "@tanstack/react-router";

import { PipelinesSettings } from "../components/settings/PipelinesSettings";

export const Route = createFileRoute("/_chat/settings/pipelines")({
  component: PipelinesSettings,
});

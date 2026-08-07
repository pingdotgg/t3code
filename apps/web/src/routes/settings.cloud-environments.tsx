import { createFileRoute } from "@tanstack/react-router";

import { CloudEnvironmentsSettings } from "../components/settings/CloudEnvironmentsSettings";

export const Route = createFileRoute("/settings/cloud-environments")({
  component: CloudEnvironmentsSettings,
});

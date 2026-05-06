import { createFileRoute } from "@tanstack/react-router";

import { SourceControlSettings } from "../components/settings/SourceControlSettings";

export const Route = createFileRoute("/settings/source-control")({
  component: SourceControlSettings,
});

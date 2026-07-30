import { createFileRoute } from "@tanstack/react-router";

import { ThreadsSettingsPanel } from "../components/settings/ThreadsSettingsPanel";

export const Route = createFileRoute("/settings/threads")({
  component: ThreadsSettingsPanel,
});

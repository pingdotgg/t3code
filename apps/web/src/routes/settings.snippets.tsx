import { createFileRoute } from "@tanstack/react-router";

import { SnippetsSettingsPanel } from "../components/settings/SnippetsSettings";

export const Route = createFileRoute("/settings/snippets")({
  component: SnippetsSettingsPanel,
});

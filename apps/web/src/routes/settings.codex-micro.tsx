import { createFileRoute } from "@tanstack/react-router";

import { CodexMicroSettingsPanel } from "../components/settings/CodexMicroSettings";

export const Route = createFileRoute("/settings/codex-micro")({
  component: CodexMicroSettingsPanel,
});

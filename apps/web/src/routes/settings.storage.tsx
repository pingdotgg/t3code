import { createFileRoute } from "@tanstack/react-router";

import { StorageSettingsPanel } from "../components/settings/StorageSettings";

export const Route = createFileRoute("/settings/storage")({
  component: StorageSettingsPanel,
});

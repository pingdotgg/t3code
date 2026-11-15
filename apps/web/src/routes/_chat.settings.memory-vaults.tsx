import { createFileRoute } from "@tanstack/react-router";

import { MemoryVaultsSettingsPanel } from "../components/memoryVaults/MemoryVaultsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/memory-vaults")({
  component: MemoryVaultsSettingsPanel,
});

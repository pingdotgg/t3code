import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/ArchiveSettings";

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedThreadsPanel,
});

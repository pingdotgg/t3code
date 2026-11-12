import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/ArchivedThreadsPanel";

export const Route = createFileRoute("/_chat/settings/archived")({
  component: ArchivedThreadsPanel,
});

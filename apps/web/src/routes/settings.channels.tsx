import { createFileRoute } from "@tanstack/react-router";

import { ChannelSettings } from "../components/settings/ChannelSettings";

export const Route = createFileRoute("/settings/channels")({
  component: ChannelSettings,
});

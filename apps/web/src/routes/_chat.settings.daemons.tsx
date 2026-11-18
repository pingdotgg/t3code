import { createFileRoute } from "@tanstack/react-router";

import { DaemonsSettings } from "../components/settings/DaemonsSettings";

export const Route = createFileRoute("/_chat/settings/daemons")({
  component: DaemonsSettings,
});

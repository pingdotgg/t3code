import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";

export const Route = createFileRoute("/_chat/bots")({
  component: BotsPage,
});

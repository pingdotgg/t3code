import { createFileRoute } from "@tanstack/react-router";
import { AgentFileSyncSettings } from "../components/settings/AgentFileSyncSettings";

export const Route = createFileRoute("/_chat/settings/skills")({
  component: AgentFileSyncSettings,
});

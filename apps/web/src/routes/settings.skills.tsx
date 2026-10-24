import { createFileRoute } from "@tanstack/react-router";
import { AgentFileSyncSettings } from "../components/settings/AgentFileSyncSettings";

export const Route = createFileRoute("/settings/skills")({ component: AgentFileSyncSettings });

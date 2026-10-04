import { createFileRoute } from "@tanstack/react-router";
import { AgentDashboard } from "../components/dashboard/AgentDashboard";
export const Route = createFileRoute("/agents")({ component: AgentDashboard });

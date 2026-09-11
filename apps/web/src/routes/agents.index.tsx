import { createFileRoute } from "@tanstack/react-router";
import { AgentsBoard } from "../components/agents/AgentsBoard";

export const Route = createFileRoute("/agents/")({ component: AgentsBoard });

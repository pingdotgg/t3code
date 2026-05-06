import { createFileRoute } from "@tanstack/react-router";

import { KanbanConsoleMock } from "../components/KanbanConsoleMock";

export const Route = createFileRoute("/kanban")({
  component: KanbanConsoleMock,
});

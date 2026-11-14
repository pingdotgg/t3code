import { createFileRoute } from "@tanstack/react-router";

import { TaskBoardPage } from "../components/board/TaskBoardPage";

export const Route = createFileRoute("/_chat/board")({
  component: TaskBoardPage,
});

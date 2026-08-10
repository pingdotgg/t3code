import { createFileRoute } from "@tanstack/react-router";

import { BoardView } from "../components/board/BoardView";

export const Route = createFileRoute("/_chat/board")({
  component: BoardView,
});

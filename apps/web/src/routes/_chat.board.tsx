import { createFileRoute } from "@tanstack/react-router";

import { SessionBoard } from "../components/board/SessionBoard.tsx";

export const Route = createFileRoute("/_chat/board")({
  component: SessionBoard,
});

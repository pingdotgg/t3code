import { createFileRoute } from "@tanstack/react-router";

import { SessionBoard } from "../components/SessionBoard";

export const Route = createFileRoute("/_chat/board")({
  component: SessionBoard,
});

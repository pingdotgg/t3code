import { Navigate, createFileRoute } from "@tanstack/react-router";

import { ThreadBoardPage } from "../components/board/ThreadBoardPage";
import { useClientSettings } from "../hooks/useSettings";

function ThreadBoardRoute() {
  const enabled = useClientSettings((settings) => settings.threadBoardEnabled);
  return enabled ? <ThreadBoardPage /> : <Navigate to="/" replace />;
}

export const Route = createFileRoute("/_chat/board")({ component: ThreadBoardRoute });

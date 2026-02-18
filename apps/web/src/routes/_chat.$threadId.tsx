import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { useStore } from "../store";

function ChatThreadRouteView() {
  const { state } = useStore();
  const navigate = useNavigate();
  const { threadId } = Route.useParams();
  const threadExists = threadId ? state.threads.some((thread) => thread.id === threadId) : false;

  useEffect(() => {
    if (!threadId) {
      void navigate({ to: "/", replace: true });
      return;
    }

    if (!state.threadsHydrated) {
      return;
    }

    if (!threadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }
  }, [navigate, state.threadsHydrated, threadExists, threadId]);

  if (!threadId || !state.threadsHydrated || !threadExists) {
    return null;
  }

  return <ChatView threadId={threadId} />;
}

export const Route = createFileRoute("/_chat/$threadId")({
  component: ChatThreadRouteView,
});

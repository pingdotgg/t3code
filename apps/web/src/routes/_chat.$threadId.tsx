import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { useStore } from "../store";

export function ChatThreadRouteView() {
  const { state, dispatch } = useStore();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const threadExists = threadId ? state.threads.some((thread) => thread.id === threadId) : false;

  useEffect(() => {
    if (!threadId) {
      void navigate({ to: "/", replace: true });
      return;
    }

    if (!threadExists) {
      void navigate({ to: "/", replace: true });
      return;
    }

    if (state.activeThreadId === threadId) {
      return;
    }

    dispatch({ type: "SET_ACTIVE_THREAD", threadId });
  }, [dispatch, navigate, state.activeThreadId, threadExists, threadId]);

  if (!threadId || !threadExists) {
    return null;
  }

  return <ChatView threadId={threadId} />;
}

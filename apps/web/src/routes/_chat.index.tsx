import { createFileRoute } from "@tanstack/react-router";

import { NoActiveThreadState } from "../components/NoActiveThreadState";

function ChatIndexRouteView() {
  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

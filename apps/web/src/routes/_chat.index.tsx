import { createFileRoute } from "@tanstack/react-router";

function ChatIndexRouteView() {
  return null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

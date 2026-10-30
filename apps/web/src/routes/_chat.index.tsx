import { createFileRoute } from "@tanstack/react-router";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { IndexDraftLanding } from "../components/IndexDraftLanding";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

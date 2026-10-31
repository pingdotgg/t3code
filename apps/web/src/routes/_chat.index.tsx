import { createFileRoute } from "@tanstack/react-router";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  // With a project to start a thread in, the index shows the layout instead
  // (useIndexShowsLayout); before that it is the no-projects home.
  return <NoProjectsHero />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

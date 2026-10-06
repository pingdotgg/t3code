import { createFileRoute } from "@tanstack/react-router";

import { ConnectAgentSurface } from "../components/auth/ConnectAgentSurface";

export const Route = createFileRoute("/connect-agent")({
  component: ConnectAgentSurface,
});

import { createFileRoute, redirect } from "@tanstack/react-router";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { ApproveAgentSurface } from "../components/auth/ApproveAgentSurface";
import { isHostedStaticApp } from "../hostedPairing";

export const Route = createFileRoute("/approve-agent")({
  beforeLoad: () => {
    if (!isHostedStaticApp() || !hasCloudPublicConfig()) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: ApproveAgentSurface,
});

import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { redirect, createFileRoute } from "@tanstack/react-router";

import { connectCliAuthRoutesEnabled } from "../cloud/connectCliAuth";
import { ConnectCliAuthorizeSurface } from "../components/cloud/ConnectCliAuthSurface";

export const Route = createFileRoute("/connect")({
  beforeLoad: () => {
    if (!connectCliAuthRoutesEnabled()) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: definePluginRouteRenderer("/connect", "component", ConnectCliAuthorizeSurface),
});

registerBuiltinRoute("/connect", Route);

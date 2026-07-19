import { createFileRoute, redirect } from "@tanstack/react-router";

import { connectCliAuthRoutesEnabled } from "../cloud/connectCliAuth";
import { ConnectCliAuthorizeSurface } from "../components/cloud/ConnectCliAuthSurface";

export const Route = createFileRoute("/connect")({
  beforeLoad: () => {
    if (!connectCliAuthRoutesEnabled()) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: ConnectCliAuthorizeSurface,
});

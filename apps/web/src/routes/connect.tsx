import { createFileRoute, redirect } from "@tanstack/react-router";

import { isConnectCliAuthEnabled } from "../cloud/connectCliAuth";
import { ConnectCliAuthorizeSurface } from "../components/ConnectCliAuthSurface";

export const Route = createFileRoute("/connect")({
  beforeLoad: () => {
    if (!isConnectCliAuthEnabled()) throw redirect({ to: "/", replace: true });
  },
  component: ConnectCliAuthorizeSurface,
});

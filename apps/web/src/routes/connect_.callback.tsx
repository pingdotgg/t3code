import { createFileRoute, redirect } from "@tanstack/react-router";

import { isConnectCliAuthEnabled } from "../cloud/connectCliAuth";
import { ConnectCliCallbackSurface } from "../components/ConnectCliAuthSurface";

export const Route = createFileRoute("/connect_/callback")({
  beforeLoad: () => {
    if (!isConnectCliAuthEnabled()) throw redirect({ to: "/", replace: true });
  },
  component: ConnectCliCallbackSurface,
});

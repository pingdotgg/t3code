import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import { definePluginComponent } from "~/plugins/features";

const PairRouteView = definePluginComponent(
  "component:routes/pair/PairRouteView",
  PluginOriginalPairRouteView,
);
const PairRoutePendingView = definePluginComponent(
  "component:routes/pair/PairRoutePendingView",
  PluginOriginalPairRoutePendingView,
);

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "guest"
    ) {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: definePluginRouteRenderer("/pair", "component", PairRouteView),
  pendingComponent: definePluginRouteRenderer("/pair", "pendingComponent", PairRoutePendingView),
});

function PluginOriginalPairRouteView() {
  const router = useRouter();
  const { authGateState } = Route.useRouteContext();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        // Recreate the connection so WebSocket and cached scopes use the new pairing cookie.
        router.history.replace("/");
        router.history.flush();
        window.location.reload();
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PluginOriginalPairRoutePendingView() {
  return <PairingPendingSurface />;
}

registerBuiltinRoute("/pair", Route);

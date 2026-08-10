import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import { parsePairRouteSearch, resolveMarketingReturnPath } from "../productDomain";

export type PairRouteDestination =
  | { readonly to: "/" }
  | { readonly to: "/marketing" }
  | { readonly to: "/marketing/$"; readonly params: { readonly _splat: string } };

export function resolvePairRouteDestination(marketingReturnTo: unknown): PairRouteDestination {
  const returnTo = resolveMarketingReturnPath(marketingReturnTo);
  if (returnTo === undefined) {
    return { to: "/" };
  }
  if (returnTo === "/marketing") {
    return { to: "/marketing" };
  }
  return {
    to: "/marketing/$",
    params: { _splat: returnTo.slice("/marketing/".length) },
  };
}

export const Route = createFileRoute("/pair")({
  validateSearch: parsePairRouteSearch,
  beforeLoad: async ({ context, search }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (authGateState.status === "authenticated" || authGateState.status === "hosted-static") {
      const destination = resolvePairRouteDestination(search.marketingReturnTo);
      if (destination.to === "/marketing/$") {
        throw redirect({ ...destination, replace: true });
      }
      throw redirect({ to: destination.to, replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { marketingReturnTo } = Route.useSearch();
  const router = useRouter();

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
        const destination = resolvePairRouteDestination(marketingReturnTo);
        if (destination.to === "/marketing/$") {
          void router.navigate({ ...destination, replace: true });
          return;
        }
        void router.navigate({ to: destination.to, replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}

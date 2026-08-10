import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  productDomainPath,
  resolveMarketingReturnPath,
  type MarketingRoutePath,
} from "../productDomain";

type MarketingGateStatus = "authenticated" | "hosted-pairing" | "hosted-static" | "requires-auth";

export type MarketingRouteAccess =
  | { readonly kind: "allow" }
  | { readonly kind: "connect-required" }
  | { readonly kind: "pair"; readonly returnTo: MarketingRoutePath };

/** Route access is separate from the request-scoped Marketing actor owned by issue #6. */
export function resolveMarketingRouteAccess(
  status: MarketingGateStatus,
  pathname: string,
): MarketingRouteAccess {
  if (status === "authenticated") {
    return { kind: "allow" };
  }
  if (status === "hosted-static") {
    return { kind: "connect-required" };
  }
  return {
    kind: "pair",
    returnTo: resolveMarketingReturnPath(pathname) ?? "/marketing",
  };
}

export class MarketingVerifiedActorRequiredError extends Error {
  override readonly name = "MarketingVerifiedActorRequiredError";
}

export const Route = createFileRoute("/marketing")({
  caseSensitive: true,
  beforeLoad: ({ context, location }) => {
    const access = resolveMarketingRouteAccess(context.authGateState.status, location.pathname);
    if (access.kind === "pair") {
      throw redirect({
        to: "/pair",
        search: { marketingReturnTo: access.returnTo },
        replace: true,
      });
    }
    if (access.kind === "connect-required") {
      throw new MarketingVerifiedActorRequiredError(
        "Marketing requires a verified actor from a connected environment.",
      );
    }
  },
  component: MarketingDomainRouteLayout,
  pendingComponent: MarketingDomainPendingView,
  errorComponent: MarketingDomainErrorView,
  pendingMs: 0,
  pendingMinMs: 0,
});

function MarketingDomainRouteLayout() {
  return <Outlet />;
}

export function MarketingDomainPendingView() {
  return (
    <main
      aria-busy="true"
      aria-labelledby="marketing-loading-title"
      aria-live="polite"
      data-product-domain="marketing"
      role="status"
    >
      <h1 id="marketing-loading-title">Opening Marketing</h1>
      <p>The isolated Marketing workspace is loading.</p>
    </main>
  );
}

export function MarketingDomainErrorView({
  error,
  reset,
  devExit,
  connectionsLink,
}: ErrorComponentProps & {
  readonly devExit?: ReactNode;
  readonly connectionsLink?: ReactNode;
}) {
  if (error instanceof MarketingVerifiedActorRequiredError) {
    return (
      <main aria-labelledby="marketing-connect-title" data-product-domain="marketing">
        <h1 id="marketing-connect-title">Connect an environment to use Marketing</h1>
        <p>
          A connected environment with a verified Marketing actor is required. No Marketing data was
          loaded.
        </p>
        {connectionsLink ?? <Link to="/settings/connections">Open Connections</Link>}
        {devExit ?? <ProductDomainDevExit />}
      </main>
    );
  }

  const message = error instanceof Error && error.message.trim() ? error.message : null;
  return (
    <main aria-labelledby="marketing-error-title" data-product-domain="marketing">
      <h1 id="marketing-error-title">Marketing is unavailable</h1>
      <p>This failure is contained to Marketing. Native T3 Dev is still available.</p>
      {message ? <p role="alert">{message}</p> : null}
      <button type="button" onClick={() => reset()}>
        Try Marketing again
      </button>
      {devExit ?? <ProductDomainDevExit />}
    </main>
  );
}

export function ProductDomainDevExit() {
  return <Link to={productDomainPath("dev")}>Return to Dev</Link>;
}

import { Link, createLazyFileRoute, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { productDomainPath } from "../productDomain";

export const Route = createLazyFileRoute("/marketing")({
  component: MarketingDomainPlaceholder,
  pendingComponent: MarketingDomainPendingView,
  errorComponent: MarketingDomainErrorView,
});

/** Issue #21 replaces this boundary proof with the approved Marketing shell. */
export function MarketingDomainPlaceholder({ devExit }: { readonly devExit?: ReactNode }) {
  return (
    <main aria-labelledby="marketing-domain-title" data-product-domain="marketing">
      <h1 id="marketing-domain-title">Marketing</h1>
      <p>The isolated Marketing product domain is active.</p>
      {devExit ?? <ProductDomainDevExit />}
    </main>
  );
}

export function MarketingDomainPendingView() {
  return (
    <main aria-labelledby="marketing-loading-title" data-product-domain="marketing">
      <h1 id="marketing-loading-title">Opening Marketing</h1>
      <p>The isolated Marketing workspace is loading.</p>
    </main>
  );
}

export function MarketingDomainErrorView({
  error,
  reset,
  devExit,
}: ErrorComponentProps & { readonly devExit?: ReactNode }) {
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

function ProductDomainDevExit() {
  return <Link to={productDomainPath("dev")}>Return to Dev</Link>;
}

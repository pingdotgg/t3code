import { Link, createLazyFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { productDomainPath } from "../productDomain";

export const Route = createLazyFileRoute("/marketing/$")({
  component: MarketingRouteNotFoundView,
});

export function MarketingRouteNotFoundView({
  marketingLink,
  devExit,
}: {
  readonly marketingLink?: ReactNode;
  readonly devExit?: ReactNode;
}) {
  return (
    <main aria-labelledby="marketing-not-found-title" data-product-domain="marketing">
      <h1 id="marketing-not-found-title">Marketing page unavailable</h1>
      <p>This address is reserved for Marketing, but no Marketing page exists here yet.</p>
      {marketingLink ?? <Link to={productDomainPath("marketing")}>Open Marketing</Link>}
      {devExit ?? <Link to={productDomainPath("dev")}>Return to Dev</Link>}
    </main>
  );
}

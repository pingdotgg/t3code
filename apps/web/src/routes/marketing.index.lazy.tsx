import { createLazyFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ProductDomainDevExit } from "./marketing";

export const Route = createLazyFileRoute("/marketing/")({
  component: MarketingDomainPlaceholder,
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

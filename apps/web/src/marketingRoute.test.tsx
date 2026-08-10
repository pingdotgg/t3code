import { expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MarketingDomainErrorView,
  MarketingDomainPendingView,
  MarketingDomainPlaceholder,
} from "./routes/marketing.lazy";

it("renders a truthful isolated Marketing boundary with an explicit Dev exit", () => {
  const markup = renderToStaticMarkup(
    <MarketingDomainPlaceholder devExit={<a href="/">Return to Dev</a>} />,
  );

  expect(markup).toContain('data-product-domain="marketing"');
  expect(markup).toContain("The isolated Marketing product domain is active.");
  expect(markup).toContain('<a href="/">Return to Dev</a>');
});

it("contains Marketing loading and failure states without replacing Dev", () => {
  const pendingMarkup = renderToStaticMarkup(<MarketingDomainPendingView />);
  const errorMarkup = renderToStaticMarkup(
    <MarketingDomainErrorView
      error={new Error("Marketing failed to load")}
      reset={() => {}}
      devExit={<a href="/">Return to Dev</a>}
    />,
  );

  expect(pendingMarkup).toContain("The isolated Marketing workspace is loading.");
  expect(errorMarkup).toContain("This failure is contained to Marketing.");
  expect(errorMarkup).toContain("Native T3 Dev is still available.");
  expect(errorMarkup).toContain("Marketing failed to load");
  expect(errorMarkup).toContain('<a href="/">Return to Dev</a>');
});

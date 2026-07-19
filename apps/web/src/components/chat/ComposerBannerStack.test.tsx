import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

function banner(id: string, title: string): ComposerBannerStackItem {
  return {
    id,
    variant: "warning",
    icon: <span aria-hidden="true">!</span>,
    title,
  };
}

describe("ComposerBannerStack", () => {
  it("keeps the hero header visible when there are no banners", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack header={<h1>Hero headline</h1>} items={[]} />,
    );

    expect(markup).toContain("Hero headline");
    expect(markup).toContain("pb-8");
  });

  it("places expanded banners in flow between the header and front banner", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        header={<h1>Hero headline</h1>}
        items={[banner("front", "Front banner"), banner("stacked", "Stacked banner")]}
      />,
    );

    expect(markup).toContain("grid-rows-[0fr]");
    expect(markup).toContain("group-hover/banner-stack:grid-rows-[1fr]");
    expect(markup).not.toContain("invisible");
    expect(markup.indexOf("Hero headline")).toBeLessThan(markup.indexOf("Stacked banner"));
    expect(markup.indexOf("Stacked banner")).toBeLessThan(markup.indexOf("Front banner"));
  });
});

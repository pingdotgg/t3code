import { ProviderDriverKind } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HermesIcon, OpenClawIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider icon mapping", () => {
  it("uses the official Hermes Agent icon for Hermes surfaces", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("hermes")]).toBe(HermesIcon);
    expect(renderToStaticMarkup(createElement(HermesIcon))).toContain(
      'href="/hermes-agent-logo.png"',
    );
  });

  it("uses the OpenClaw icon for OpenClaw surfaces", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("openclaw")]).toBe(OpenClawIcon);
    const markup = renderToStaticMarkup(createElement(OpenClawIcon));
    expect(markup).toContain('viewBox="0 0 120 120"');
    expect(markup).toContain("openclaw__lobster-gradient");
    expect(markup).toContain("#00e5cc");
  });
});

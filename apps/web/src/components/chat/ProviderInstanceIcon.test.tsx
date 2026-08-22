import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const OPENCODE = ProviderDriverKind.make("opencode");
const OPENCODE2 = ProviderDriverKind.make("opencode2");

describe("ProviderInstanceIcon OpenCode marks", () => {
  it("renders distinct OpenCode components without an icon badge", () => {
    const opencode = renderToStaticMarkup(
      <ProviderInstanceIcon driverKind={OPENCODE} displayName="OpenCode" />,
    );
    const opencode2 = renderToStaticMarkup(
      <ProviderInstanceIcon driverKind={OPENCODE2} displayName="OpenCode 2" />,
    );

    expect(opencode).toContain('data-provider-icon="opencode"');
    expect(opencode2).toContain('data-provider-icon="opencode2"');
    expect(opencode2).not.toContain("data-provider-kind-badge");
  });

  it("keeps custom instance badges independent of the provider mark", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        driverKind={OPENCODE2}
        displayName="OpenCode Personal"
        accentColor="#3355ff"
        showBadge
      />,
    );

    expect(markup).toContain("OP");
    expect(markup).toMatch(/class="[^"]*bottom-0[^"]*"[^>]*style="border-color/);
    expect(markup).not.toContain("data-provider-kind-badge");
  });
});

import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getCustomProviderLogoSrc } from "./providerIconUtils";

describe("getCustomProviderLogoSrc", () => {
  const grok = ProviderDriverKind.make("grok");

  it("uses the Hermes logo for the Hermes ACP provider", () => {
    expect(getCustomProviderLogoSrc(grok, "hermes")).toBe("/hermes-agent.png");
  });

  it("does not replace the Grok logo for other Grok instances", () => {
    expect(getCustomProviderLogoSrc(grok, "grok")).toBeUndefined();
    expect(getCustomProviderLogoSrc(grok, "grok_custom")).toBeUndefined();
  });

  it("does not brand a non-Grok provider as Hermes", () => {
    expect(getCustomProviderLogoSrc(ProviderDriverKind.make("codex"), "hermes")).toBeUndefined();
  });
});

describe("ProviderInstanceIcon", () => {
  const grok = ProviderDriverKind.make("grok");

  it("renders the Hermes mark without the generic initials badge", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        instanceId="hermes"
        driverKind={grok}
        displayName="My Hermes agent"
        accentColor="#8B5CF6"
        showBadge
      />,
    );

    expect(markup).toContain('src="/hermes-agent.png"');
    expect(markup).not.toContain(">HE</span>");
  });

  it("renders the Hermes mark at the compact model-row size", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        instanceId="hermes"
        driverKind={grok}
        displayName="Hermes"
        className="size-3"
        iconClassName="size-3"
      />,
    );

    expect(markup).toContain('src="/hermes-agent.png"');
    expect(markup).toContain("size-3");
    expect(markup).not.toContain("<svg");
  });

  it("does not identify Hermes from an editable display name", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        instanceId="grok_custom"
        driverKind={grok}
        displayName="Hermes"
        accentColor="#8B5CF6"
        showBadge
      />,
    );

    expect(markup).not.toContain("hermes-agent.png");
    expect(markup).toContain(">HE</span>");
  });
});

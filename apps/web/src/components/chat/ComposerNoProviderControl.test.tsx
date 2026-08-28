import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    createElement("a", { href: to, ...props }, children),
}));

import { ComposerNoProviderControl } from "./ComposerNoProviderControl";

describe("ComposerNoProviderControl", () => {
  it("links the empty-provider chip to provider settings", () => {
    const markup = renderToStaticMarkup(<ComposerNoProviderControl />);

    expect(markup).toContain('href="/settings/providers"');
    expect(markup).toContain("No provider available");
    expect(markup).toContain('data-chat-provider-unavailable="true"');
    expect(markup).toContain("Open provider settings");
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain("aria-disabled");
  });
});

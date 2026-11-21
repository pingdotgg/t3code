import { describe, expect, it } from "@effect/vitest";
import { mcpToolPresentation } from "./mcpToolPresentation.ts";

describe("mcpToolPresentation", () => {
  it.each([
    "javascript:alert(1)",
    "file:///tmp/logo.png",
    "not a URL",
    "https://example.com/" + "x".repeat(4096),
  ])("ignores an invalid logo %s", (iconUrl) => {
    expect(
      mcpToolPresentation({
        serverName: "weather",
        toolName: "get_weather",
        iconUrl,
        title: "x".repeat(161),
      }),
    ).toEqual({
      title: "get weather",
      toolSource: { key: "mcp:weather", name: "weather", kind: "integration" },
    });
  });

  const vercelIcons = [
    {
      src: "https://mcp.vercel.com/icons/vercel-light.svg",
      mimeType: "image/svg+xml",
      sizes: ["any"],
      theme: "light",
    },
    {
      src: "https://mcp.vercel.com/icons/vercel-dark.svg",
      mimeType: "image/svg+xml",
      sizes: ["any"],
      theme: "dark",
    },
  ];
  const exaIcons = [
    { src: "https://exa.ai/images/favicon-32x32.png", mimeType: "image/png", sizes: ["32x32"] },
    { src: "https://exa.ai/images/logo/exa-logomark-blue.svg", mimeType: "image/svg+xml" },
  ];

  it.each([
    {
      name: "a declared server icon over the provider's and the site's",
      server: {
        icons: [{ src: "https://ref.tools/images/logo.png" }],
        url: "https://api.ref.tools/mcp",
      },
      iconUrl: "https://www.google.com/s2/favicons?domain=ref.tools&sz=64",
      icon: { _tag: "themed-logo", logoUrl: "https://ref.tools/images/logo.png" },
    },
    {
      name: "light and dark icons by theme",
      server: { icons: vercelIcons },
      icon: {
        _tag: "themed-logo",
        logoUrl: "https://mcp.vercel.com/icons/vercel-light.svg",
        logoUrlDark: "https://mcp.vercel.com/icons/vercel-dark.svg",
      },
    },
    {
      name: "an unthemed icon for dark when only a light one is themed",
      server: { icons: [vercelIcons[0], { src: "https://mcp.vercel.com/icons/vercel.png" }] },
      icon: {
        _tag: "themed-logo",
        logoUrl: "https://mcp.vercel.com/icons/vercel-light.svg",
        logoUrlDark: "https://mcp.vercel.com/icons/vercel.png",
      },
    },
    {
      name: "a dark-only icon for both themes",
      server: { icons: [vercelIcons[1]] },
      icon: { _tag: "themed-logo", logoUrl: "https://mcp.vercel.com/icons/vercel-dark.svg" },
    },
    {
      name: "a scalable icon over a raster one",
      server: { icons: exaIcons },
      icon: { _tag: "themed-logo", logoUrl: "https://exa.ai/images/logo/exa-logomark-blue.svg" },
    },
    {
      name: "the provider's logo when nothing is declared",
      server: {
        icons: [
          { src: "data:image/png;base64,AAAA" },
          { src: "https://example.com/readme", mimeType: "text/html" },
        ],
        url: "https://mcp.example.org/mcp",
      },
      iconUrl: "https://example.org/logo.png",
      icon: { _tag: "themed-logo", logoUrl: "https://example.org/logo.png" },
    },
    {
      name: "the declared website",
      server: { websiteUrl: "https://higgsfield.ai/about?ref=mcp", url: "https://mcp.example.org" },
      icon: { _tag: "website", pageUrl: "https://higgsfield.ai" },
    },
    {
      name: "the server's brand origin without its path or query",
      server: { url: "https://mcp.higgsfield.ai/mcp?api_key=secret" },
      icon: { _tag: "website", pageUrl: "https://higgsfield.ai" },
    },
    {
      name: "a two-label host as is",
      server: { url: "https://api.dev:8443/mcp" },
      icon: { _tag: "website", pageUrl: "https://api.dev:8443" },
    },
    {
      name: "no site icon for a private host",
      server: { url: "http://localhost:3845/mcp" },
      icon: undefined,
    },
  ])("uses $name", ({ server, iconUrl, icon }) => {
    const presentation = mcpToolPresentation({
      toolName: "mcp__docs__search",
      ...(iconUrl ? { iconUrl } : {}),
      server,
    });
    expect(presentation.toolSource?.icon).toEqual(icon);
    expect(presentation.toolIcon).toEqual(icon);
  });

  it("uses a declared tool icon for the row and the server's icon for its source", () => {
    const presentation = mcpToolPresentation({
      toolName: "mcp__vercel__deploy",
      server: { icons: vercelIcons, toolIcons: [{ src: "https://mcp.vercel.com/deploy.svg" }] },
    });
    expect(presentation.toolIcon).toEqual({
      _tag: "themed-logo",
      logoUrl: "https://mcp.vercel.com/deploy.svg",
    });
    expect(presentation.toolSource?.icon).toMatchObject({
      logoUrl: "https://mcp.vercel.com/icons/vercel-light.svg",
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { parseLinkPreviewHtml } from "./linkPreview.ts";

describe("parseLinkPreviewHtml", () => {
  it("prefers social tags in any attribute order and decodes entities", () => {
    const html = `<html><head><title>Fallback</title>
      <meta content='Tom &amp; Jerry&#39;s &#x1F600;' property="og:title">
      <meta name=description content="Plain description">
      <meta property="og:description" content="  Social
        description  "></head></html>`;
    expect(parseLinkPreviewHtml(html)).toEqual({
      title: "Tom & Jerry's 😀",
      description: "Social description",
    });
  });

  it("falls back to the document title and reports missing fields as null", () => {
    expect(parseLinkPreviewHtml("<title lang=en>\n Docs  page </title>")).toEqual({
      title: "Docs page",
      description: null,
    });
    expect(parseLinkPreviewHtml("<p>no head</p>")).toEqual({ title: null, description: null });
  });

  it("truncates long text", () => {
    const { title } = parseLinkPreviewHtml(`<title>${"a".repeat(400)}</title>`);
    expect(title).toHaveLength(300);
    expect(title?.endsWith("…")).toBe(true);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";

describe("resolveMarkdownLinkPresentation", () => {
  it("extracts external link hosts", () => {
    expect(resolveMarkdownLinkPresentation("https://example.com/docs?q=1")).toEqual({
      kind: "external",
      href: "https://example.com/docs?q=1",
      host: "example.com",
    });
  });

  it("renders file URLs as basename pills with positions", () => {
    expect(
      resolveMarkdownLinkPresentation("file:///Users/julius/project/src/main.ts#L42C7"),
    ).toEqual({
      kind: "file",
      icon: "typescript",
      label: "main.ts:42:7",
    });
  });

  it("recognizes relative source paths and bare filenames", () => {
    expect(resolveMarkdownLinkPresentation("apps/mobile/src/index.ts:10")).toEqual({
      kind: "file",
      icon: "typescript",
      label: "index.ts:10",
    });
    expect(resolveMarkdownLinkPresentation("AGENTS.md")).toEqual({
      kind: "file",
      icon: "agents",
      label: "AGENTS.md",
    });
    expect(resolveMarkdownLinkPresentation("package.json")).toEqual({
      kind: "file",
      icon: "package",
      label: "package.json",
    });
  });

  it("uses the Pierre complete icon mappings", () => {
    expect(resolveMarkdownLinkPresentation("src/Button.tsx")).toMatchObject({
      kind: "file",
      icon: "react",
    });
    expect(resolveMarkdownLinkPresentation("vite.config.ts")).toMatchObject({
      kind: "file",
      icon: "vite",
    });
    expect(resolveMarkdownLinkPresentation("Dockerfile")).toMatchObject({
      kind: "file",
      icon: "docker",
    });
    expect(resolveMarkdownLinkPresentation("pnpm-lock.yaml")).toMatchObject({
      kind: "file",
      icon: "pnpm",
    });
  });

  it("does not style app routes as file links", () => {
    expect(resolveMarkdownLinkPresentation("/chat/settings")).toEqual({
      kind: "link",
      href: null,
    });
  });
});

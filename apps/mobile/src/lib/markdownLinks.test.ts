import { describe, expect, it } from "vite-plus/test";

import {
  resolveMarkdownLinkIcon,
  resolveMarkdownLinkPresentation,
} from "@t3tools/mobile-markdown-text/links";

describe("resolveMarkdownLinkIcon", () => {
  it("gives GitHub hosts the brand mark and everything else the generic glyph", () => {
    expect(resolveMarkdownLinkIcon("github.com")).toBe("github");
    expect(resolveMarkdownLinkIcon("GitHub.com")).toBe("github");
    expect(resolveMarkdownLinkIcon("gist.github.com")).toBe("github");
    expect(resolveMarkdownLinkIcon("github.community")).toBeNull();
    expect(resolveMarkdownLinkIcon("notgithub.com")).toBeNull();
    expect(resolveMarkdownLinkIcon("example.com")).toBeNull();
  });
});

describe("resolveMarkdownLinkPresentation", () => {
  it("treats protocol-relative media as an external URL, not a filesystem path", () => {
    expect(resolveMarkdownLinkPresentation("//cdn.example.com/clip.mp4?sig=a%2fb#t=2")).toEqual({
      kind: "external",
      href: "https://cdn.example.com/clip.mp4?sig=a%2fb#t=2",
      host: "cdn.example.com",
    });
  });

  it("separates encoded filename characters from a video playback fragment", () => {
    expect(resolveMarkdownLinkPresentation("/tmp/clip%23one.mp4#t=2")).toMatchObject({
      path: "/tmp/clip#one.mp4",
      label: "clip#one.mp4",
      icon: "video",
    });
  });

  it("extracts external link hosts", () => {
    expect(resolveMarkdownLinkPresentation("https://example.com/docs?q=1")).toEqual({
      kind: "external",
      href: "https://example.com/docs?q=1",
      host: "example.com",
    });
  });

  it.each([
    ["file:///Users/julius/project/src/main.ts#L42C7", "/Users/julius/project/src/main.ts"],
    ["file://server/share/src/main.ts#L42C7", "\\\\server\\share\\src\\main.ts"],
  ])("preserves the file URL path and position for %s", (href, path) => {
    expect(resolveMarkdownLinkPresentation(href)).toEqual({
      kind: "file",
      href,
      icon: "typescript",
      label: "main.ts:42:7",
      path,
      line: 42,
      column: 7,
    });
  });

  it("recognizes relative source paths and bare filenames", () => {
    expect(resolveMarkdownLinkPresentation("apps/mobile/src/index.ts:10")).toEqual({
      kind: "file",
      href: "apps/mobile/src/index.ts:10",
      icon: "typescript",
      label: "index.ts:10",
      path: "apps/mobile/src/index.ts",
      line: 10,
    });
    expect(resolveMarkdownLinkPresentation("AGENTS.md")).toEqual({
      kind: "file",
      href: "AGENTS.md",
      icon: "agents",
      label: "AGENTS.md",
      path: "AGENTS.md",
    });
    expect(resolveMarkdownLinkPresentation("package.json")).toEqual({
      kind: "file",
      href: "package.json",
      icon: "package",
      label: "package.json",
      path: "package.json",
    });
  });

  it.each(["md", "html", "xml"])("recognizes a bare spaced .%s filename", (extension) => {
    expect(
      resolveMarkdownLinkPresentation(`Updated%20cutover%20checklist.${extension}`),
    ).toMatchObject({
      kind: "file",
      path: `Updated cutover checklist.${extension}`,
      label: `Updated cutover checklist.${extension}`,
    });
  });

  it("recognizes spaced relative paths", () => {
    expect(resolveMarkdownLinkPresentation("docs/My%20Folder/checklist.xml")).toMatchObject({
      kind: "file",
      path: "docs/My Folder/checklist.xml",
      label: "checklist.xml",
    });
  });

  it("extracts line fragments from relative file links", () => {
    expect(resolveMarkdownLinkPresentation("src/main.ts#L18C2")).toMatchObject({
      kind: "file",
      path: "src/main.ts",
      line: 18,
      column: 2,
      label: "main.ts:18:2",
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

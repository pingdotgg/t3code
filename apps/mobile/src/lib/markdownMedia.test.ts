import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownMediaPreview } from "./markdownMedia";
import { resolveMarkdownLinkPresentation } from "./markdownLinks";

const input = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  workspaceRoot: "/repo",
};

describe("resolveMarkdownMediaPreview", () => {
  it("decodes remote filenames once without changing the authored URL", () => {
    const href = "https://cdn.example.com/clip%20one%2520%2Emp4?signature=a%2fb#t=2";
    expect(resolveMarkdownMediaPreview(href, input)).toMatchObject({
      kind: "video",
      source: {
        uri: href,
        actionsSource: {
          name: "clip one%20.mp4",
          mimeType: "video/mp4",
          reference: { kind: "url", url: href },
        },
      },
    });
  });

  it("provides extensionless image actions only for image embeds", () => {
    const href = "https://cdn.example.com/render?id=42";
    expect(resolveMarkdownMediaPreview(href, input)).toBeNull();
    expect(resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true })).toMatchObject({
      kind: "image",
      source: { actionsSource: { reference: { kind: "url", url: href }, mimeType: "image/*" } },
    });
  });

  it.each([
    ["/tmp/frame%23one.png", "/tmp/frame#one.png"],
    ["/tmp/frame%3Fone.png", "/tmp/frame?one.png"],
    ["/tmp/frame%2523one.png", "/tmp/frame%23one.png"],
    ["file://server/share/frame.png", "\\\\server\\share\\frame.png"],
    ["\\\\server\\share\\frame.png", "\\\\server\\share\\frame.png"],
  ])("keeps encoded filename and UNC semantics for %s", (href, path) => {
    expect(resolveMarkdownMediaPreview(href, input)).toMatchObject({
      kind: "image",
      source: {
        resource: { path },
        actionsSource: { reference: { kind: "file", path } },
      },
    });
  });

  it("serves a linked T3 attachment file in place like any other host path", () => {
    const path = "/home/demo/.t3/userdata/attachments/11111111-1111-4111-8111-111111111111-mp4.mp4";
    expect(resolveMarkdownMediaPreview(path, input)).toMatchObject({
      kind: "video",
      source: {
        resource: { _tag: "media-file", threadId: input.threadId, path },
        actionsSource: { resource: { _tag: "media-file", path } },
      },
    });
  });

  it("preserves a signed PDF URL and its authored name", () => {
    const href = "//cdn.example.com/report%20one.pdf?signature=a%2fb#page=2";
    expect(resolveMarkdownMediaPreview(href, input)).toMatchObject({
      kind: "pdf",
      source: { uri: `https:${href}`, name: "report one.pdf", mimeType: "application/pdf" },
    });
  });

  it.each(["./image.png", "./report.pdf", "./sound.mp3"])(
    "uses the draft workspace when no thread exists: %s",
    (href) => {
      expect(
        resolveMarkdownMediaPreview(href, { ...input, threadId: undefined })?.source,
      ).toMatchObject({
        resource: { _tag: "draft-workspace-file", cwd: "/repo", path: `/repo/${href}` },
      });
    },
  );

  it("keeps captured host media unavailable while allowing direct media", () => {
    const captured = { ...input, captured: true };
    for (const href of ["./image.png", "./clip.mp4", "./report.pdf", "./sound.mp3"]) {
      expect(resolveMarkdownMediaPreview(href, captured)).toBeNull();
    }
    expect(resolveMarkdownMediaPreview("https://cdn.example.com/report.pdf", captured)?.kind).toBe(
      "pdf",
    );
  });

  it.each([["/tmp/sound%23one.mp3", "audio", "audio/mpeg", "/tmp/sound#one.mp3"]])(
    "opens an authored embed through the host: %s",
    (href, kind, mimeType, path) => {
      expect(resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true })).toMatchObject({
        kind,
        source: {
          kind: "document",
          name: path.split("/").at(-1),
          mimeType,
          environmentId: input.environmentId,
          resource: { _tag: "media-file", threadId: input.threadId, path },
        },
      });
    },
  );

  it.each([
    ["sound%20one.mp3", "audio"],
    ["report%20one.csv", "document"],
    ["report.tsv", "document"],
    ["report.docx", "document"],
    ["report.xlsx", "document"],
    ["report.pptx", "document"],
    ["report.unknown", "image"],
  ])("preserves direct signed embeds: %s", (name, kind) => {
    const href = `https://cdn.example.com/${name}?signature=a%2fb`;
    expect(resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true })).toMatchObject({
      kind,
      source: { uri: href, name: decodeURIComponent(name) },
    });
  });

  it.each([
    "https://docs.example.com/guide.html",
    "https://example.com/index.php?topic=files",
    "https://example.com/report.unknown",
    "https://example.com/main.tf",
    "https://example.com/schema.prisma",
    "https://example.com/chart.php?id=1",
    "http://example.com/chart.php?id=1",
    "//example.com/chart.php?id=1",
    "https://example.com/chart?format=png",
    "http://example.com/chart?format=png",
    "//example.com/chart?format=png",
  ])("keeps ordinary remote links in the browser: %s", (href) => {
    expect(resolveMarkdownMediaPreview(href, input)).toBeNull();
    expect(resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true })).toMatchObject({
      kind: "image",
      source: { uri: href.startsWith("//") ? `https:${href}` : href },
    });
  });

  it.each([
    "javascript:report.csv",
    "data:text/csv,a,b",
    "ftp://server/report.csv",
    "~/report.csv",
  ])("rejects blocked document links and embeds: %s", (href) => {
    expect(resolveMarkdownMediaPreview(href, input)).toBeNull();
    expect(resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true })).toBeNull();
  });

  it.each([
    "src/main.ts",
    "src/main.tsx",
    "report.txt",
    "report.md",
    "report.html",
    "package.json",
    "report.csv",
    "report.tsv",
    "LICENSE",
    "Dockerfile",
    "main.tf",
    "schema.prisma",
    "index.astro",
    "main.zig",
    "Containerfile",
  ])("routes text and table links and embeds to the file screen: %s", (name) => {
    for (const href of [name, "./" + name, "/tmp/" + name, "file:///tmp/" + name]) {
      for (const imageEmbed of [false, true]) {
        expect(resolveMarkdownMediaPreview(href, { ...input, imageEmbed })).toMatchObject({
          kind: "file",
          source: { name: name.split("/").at(-1) },
        });
      }
      expect(resolveMarkdownLinkPresentation(href)).toMatchObject({ kind: "file" });
    }
  });

  it.each(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "unknown", "zip"])(
    "keeps main's source reader for host %s links and embeds",
    (extension) => {
      const name = `report.${extension}`;
      for (const href of [name, `./${name}`, `/tmp/${name}`, `file:///tmp/${name}`]) {
        for (const imageEmbed of [false, true]) {
          expect(resolveMarkdownMediaPreview(href, { ...input, imageEmbed })).toMatchObject({
            kind: "file",
            source: {
              name,
              mimeType: "text/plain",
            },
          });
          expect(
            resolveMarkdownMediaPreview(href, {
              ...input,
              threadId: undefined,
              imageEmbed,
            })?.kind,
          ).toBe("file");
          expect(resolveMarkdownLinkPresentation(href)).toMatchObject({ kind: "file" });
        }
      }
    },
  );

  it.each(["report.csv", "report.tsv", "report.docx", "report.xlsx", "report.unknown"])(
    "preserves draft, captured, and encoded document paths: %s",
    (name) => {
      const href = `/tmp/one%23two%2520.${name.split(".").at(-1)}`;
      const preview = resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true });
      expect(preview?.source).toMatchObject({
        name: `one#two%20.${name.split(".").at(-1)}`,
        resource: { path: decodeURIComponent(href) },
      });
      expect(
        resolveMarkdownMediaPreview(href, { ...input, threadId: undefined })?.source,
      ).toMatchObject({ resource: { _tag: "draft-workspace-file", cwd: "/repo" } });
      expect(resolveMarkdownMediaPreview(href, { ...input, captured: true })).toBeNull();
      expect(
        resolveMarkdownMediaPreview(href, { ...input, threadId: undefined, workspaceRoot: null }),
      ).toBeNull();
    },
  );

  it.each([
    ["src/main.ts:42", "/repo/src/main.ts", 42],
    ["src/main.ts#L42C3", "/repo/src/main.ts", 42],
    ["report.csv:142:3", "/repo/report.csv", 142],
    ["/tmp/report.pdf:12#page=2", "/tmp/report.pdf", 12],
    ["file:///tmp/sound.mp3#L12", "/tmp/sound.mp3", 12],
    ["/tmp/frame%23one.png:12", "/tmp/frame#one.png", 12],
    ["./clip.mp4#L12C3", "/repo/./clip.mp4", 12],
    ["src/main.ts%3A42%3A3", "/repo/src/main.ts", 42],
  ])("keeps positioned links on the file route: %s", (href, path, line) => {
    expect(resolveMarkdownMediaPreview(href, input)).toBeNull();
    const presentation = resolveMarkdownLinkPresentation(href);
    expect(presentation).toMatchObject({ kind: "file", line });
    if (presentation.kind === "file") {
      expect(
        presentation.path.startsWith("/") ? presentation.path : "/repo/" + presentation.path,
      ).toBe(path);
    }
  });

  it.each(["mp3", "wav", "m4a", "ogg", "oga", "aac", "aiff", "flac", "opus"])(
    "resolves audio embeds as audio rather than images: %s",
    (extension) => {
      expect(
        resolveMarkdownMediaPreview("/tmp/sound." + extension, { ...input, imageEmbed: true }),
      ).toMatchObject({
        kind: "audio",
        source: { kind: "document", resource: { _tag: "media-file" } },
      });
    },
  );

  it("does not authorize local files without thread or draft context", () => {
    expect(
      resolveMarkdownMediaPreview("/tmp/report.pdf", {
        ...input,
        threadId: undefined,
        workspaceRoot: null,
      }),
    ).toBeNull();
    expect(resolveMarkdownMediaPreview("report.pdf", { ...input, workspaceRoot: null })).toBeNull();
  });

  it("decodes document filenames once and preserves image and video embeds", () => {
    expect(resolveMarkdownMediaPreview("/tmp/report%23one%2520.pdf", input)).toMatchObject({
      kind: "pdf",
      source: {
        name: "report#one%20.pdf",
        mimeType: "application/pdf",
        resource: { path: "/tmp/report#one%20.pdf" },
      },
    });
    expect(
      resolveMarkdownMediaPreview("/tmp/image.png", { ...input, imageEmbed: true })?.kind,
    ).toBe("image");
    expect(resolveMarkdownMediaPreview("/tmp/clip.mp4", { ...input, imageEmbed: true })?.kind).toBe(
      "video",
    );
  });
});

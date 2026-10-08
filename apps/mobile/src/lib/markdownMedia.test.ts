import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownMediaPreview } from "./markdownMedia";

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
    ["/tmp/frame%23one.png:12", "/tmp/frame#one.png"],
    ["/tmp/frame%3Fone.png:12:3", "/tmp/frame?one.png"],
    ["/tmp/frame%2523one.png:12", "/tmp/frame%23one.png"],
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

  it("separates a video playback fragment from literal filename characters", () => {
    expect(resolveMarkdownMediaPreview("/tmp/clip%23one.mp4#t=2", input)).toMatchObject({
      kind: "video",
      source: {
        srcFragment: "#t=2",
        resource: { path: "/tmp/clip#one.mp4" },
        actionsSource: { reference: { kind: "file", path: "/tmp/clip#one.mp4" } },
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

  it.each(["./image.png", "./clip.mp4", "./report.pdf"])(
    "opens relative media through the environment: %s",
    (href) => {
      const preview = resolveMarkdownMediaPreview(href, input);
      expect(preview?.source).toMatchObject({
        environmentId: input.environmentId,
        resource: { _tag: "media-file", threadId: input.threadId, path: `/repo/${href}` },
      });
    },
  );

  it("preserves a signed PDF URL and its authored name", () => {
    const href = "//cdn.example.com/report%20one.pdf?signature=a%2fb#page=2";
    expect(resolveMarkdownMediaPreview(href, input)).toMatchObject({
      kind: "pdf",
      source: { uri: `https:${href}`, name: "report one.pdf", mimeType: "application/pdf" },
    });
  });

  it("recognizes a URL-encoded PDF extension and filename without rewriting the URL", () => {
    const href = "https://cdn.example.com/report%23one%2520%2Epdf?signature=a%2fb";
    expect(resolveMarkdownMediaPreview(href, input)).toMatchObject({
      kind: "pdf",
      source: { uri: href, name: "report#one%20.pdf" },
    });
  });

  it("opens encoded host PDFs without interpreting literal filename characters twice", () => {
    expect(resolveMarkdownMediaPreview("/tmp/report%23one.pdf:12#page=2", input)).toMatchObject({
      kind: "pdf",
      source: { resource: { path: "/tmp/report#one.pdf" }, srcFragment: "#page=2" },
    });
  });

  it.each(["./image.png", "./clip.mp4", "./report.pdf"])(
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
    for (const href of ["./image.png", "./clip.mp4", "./report.pdf"]) {
      expect(resolveMarkdownMediaPreview(href, captured)).toBeNull();
    }
    expect(resolveMarkdownMediaPreview("https://cdn.example.com/report.pdf", captured)?.kind).toBe(
      "pdf",
    );
  });

  it("resolves protocol-relative media for native APIs without rewriting its signed query", () => {
    expect(
      resolveMarkdownMediaPreview("//cdn.example.com/clip.mp4?signature=a%2fb#t=2", input),
    ).toMatchObject({
      kind: "video",
      source: {
        uri: "https://cdn.example.com/clip.mp4?signature=a%2fb#t=2",
        actionsSource: {
          reference: { kind: "url", url: "//cdn.example.com/clip.mp4?signature=a%2fb#t=2" },
        },
      },
    });
  });
});

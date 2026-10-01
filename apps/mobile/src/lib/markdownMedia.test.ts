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

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownMediaSource } from "./MarkdownMedia";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("resolveMarkdownMediaSource", () => {
  it("keeps browser-loadable media URLs direct", () => {
    expect(resolveMarkdownMediaSource("//cdn.example.test/demo.mp4", threadRef)).toEqual({
      _tag: "direct",
      url: "//cdn.example.test/demo.mp4",
    });
  });

  it("resolves workspace media after decoding and removing query strings", () => {
    expect(resolveMarkdownMediaSource("./recordings/demo%20run.mp4?download=1", threadRef)).toEqual(
      {
        _tag: "resource",
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "recordings/demo run.mp4",
        },
      },
    );
  });

  it("recognizes only absolute browser-artifact paths", () => {
    expect(
      resolveMarkdownMediaSource(
        "/tmp/userdata/browser-artifacts/browser-recording-demo.webm",
        threadRef,
      ),
    ).toEqual({
      _tag: "resource",
      resource: {
        _tag: "browser-artifact",
        fileName: "browser-recording-demo.webm",
      },
    });
    expect(
      resolveMarkdownMediaSource("docs/browser-artifacts/browser-recording-demo.webm", threadRef),
    ).toMatchObject({
      resource: {
        _tag: "workspace-file",
        path: "docs/browser-artifacts/browser-recording-demo.webm",
      },
    });
  });

  it("unescapes sanitized Windows drive paths", () => {
    expect(
      resolveMarkdownMediaSource(
        "/C:\\Users\\me\\browser-artifacts\\browser-screenshot-demo.png",
        threadRef,
      ),
    ).toMatchObject({
      resource: {
        _tag: "browser-artifact",
        fileName: "browser-screenshot-demo.png",
      },
    });
  });
});

import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "../../lib/markdownDocument";
import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";

describe("PR attachments", () => {
  it("combines embedded images and detected media without duplicate URLs", () => {
    const uri = "https://drop.example.com/shot.png";
    const document = {
      type: "root",
      children: [
        { type: "image", url: uri, alt: "Screenshot" },
        { type: "image", url: uri, alt: "Duplicate" },
      ],
    } as MarkdownNode;
    const media = splitPullRequestBody(
      `${uri}\n\nhttps://drop.example.com/demo.mp4\n\nhttps://github.com/user-attachments/assets/123-abc`,
    );
    expect(pullRequestDescriptionContent(document, media).attachments).toEqual([
      { uri, caption: "Screenshot", kind: "image" },
      { uri: "https://drop.example.com/demo.mp4", caption: "Video", kind: "video" },
      {
        uri: "https://github.com/user-attachments/assets/123-abc",
        caption: "Video",
        kind: "video",
      },
    ]);
  });
});

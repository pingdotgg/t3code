import { describe, expect, it } from "vite-plus/test";
import {
  markdownReferenceDefinitions,
  parseMarkdownDocument,
  type MarkdownNode,
} from "../../lib/markdownDocument";
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
      markdownReferenceDefinitions,
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

  it("collects videos from a before/after table", () => {
    const media = splitPullRequestBody(
      "<table>\n<tr><th>Before</th><th>After</th></tr>\n<tr><td>\n\nhttps://drop.example.com/before.mp4\n\n</td><td>\n\nhttps://drop.example.com/after.mp4\n\n</td></tr>\n</table>",
      markdownReferenceDefinitions,
    );
    expect(
      pullRequestDescriptionContent({ type: "root" } as MarkdownNode, media).attachments,
    ).toEqual([
      { uri: "https://drop.example.com/before.mp4", caption: "Video", kind: "video" },
      { uri: "https://drop.example.com/after.mp4", caption: "Video", kind: "video" },
    ]);
  });

  it("classifies markdown-embedded video URLs as videos instead of images", () => {
    const document = {
      type: "root",
      children: [
        { type: "image", url: "https://drop.example.com/shot.png", alt: "Screenshot" },
        {
          type: "image",
          url: "https://drop.example.com/recording.mp4?download=1",
          alt: "Recording, 36s",
        },
        { type: "image", url: "https://drop.example.com/clip.webm" },
      ],
    } as MarkdownNode;
    expect(pullRequestDescriptionContent(document).attachments).toEqual([
      { uri: "https://drop.example.com/shot.png", caption: "Screenshot", kind: "image" },
      {
        uri: "https://drop.example.com/recording.mp4?download=1",
        caption: "Recording, 36s",
        kind: "video",
      },
      { uri: "https://drop.example.com/clip.webm", caption: "Video", kind: "video" },
    ]);
  });

  it("collects reference-style markdown images with their definitions", () => {
    const document = {
      type: "root",
      children: [
        { type: "imageReference", identifier: "before", alt: "Before" },
        { type: "imageReference", identifier: "after", alt: "" },
        { type: "definition", identifier: "before", url: "https://drop.example.com/before.png" },
        {
          type: "definition",
          identifier: "after",
          url: "https://drop.example.com/after.png",
          title: "After",
        },
      ],
    } as MarkdownNode;
    expect(pullRequestDescriptionContent(document).attachments).toEqual([
      { uri: "https://drop.example.com/before.png", caption: "Before", kind: "image" },
      { uri: "https://drop.example.com/after.png", caption: "After", kind: "image" },
    ]);
  });

  it("preserves document order across bare attachments and inline markdown images", () => {
    const markdown = [
      "https://drop.example.com/before.png",
      "",
      "![Diagram](https://drop.example.com/diagram.svg)",
      "",
      "https://drop.example.com/after.png",
    ].join("\n");
    const document = parseMarkdownDocument(markdown);
    const media = splitPullRequestBody(markdown, markdownReferenceDefinitions);
    expect(pullRequestDescriptionContent(document, media).attachments).toEqual([
      { uri: "https://drop.example.com/before.png", caption: "before.png", kind: "image" },
      { uri: "https://drop.example.com/diagram.svg", caption: "Diagram", kind: "image" },
      { uri: "https://drop.example.com/after.png", caption: "after.png", kind: "image" },
    ]);
  });
});

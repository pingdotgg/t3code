import { describe, expect, it } from "vite-plus/test";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";

describe("pull request description content", () => {
  it("ignores malformed image URLs while keeping the description and valid attachments", () => {
    const result = pullRequestDescriptionContent(
      parseMarkdownDocument(
        [
          "The pull request remains readable.",
          "![Missing host](https://)",
          "![Invalid host](<https://a b>)",
          '<img src="https://:80" alt="Invalid port">',
          "![Unsupported](file:///screenshots/local.png)",
          "![Screenshot](http://example.com/screenshot.png)",
        ].join("\n\n"),
      ),
    );

    expect(result.attachments).toEqual([
      { uri: "http://example.com/screenshot.png", caption: "Screenshot", kind: "image" },
    ]);
    expect(result.preview).toContain("The pull request remains readable.");
  });

  it("keeps screenshot attachments and does not turn code examples or local paths into media", () => {
    const result = pullRequestDescriptionContent(
      parseMarkdownDocument(
        [
          "Fixes reconnects.",
          "```markdown\n![Example](https://example.com/code.png)\n```",
          "![Before](https://example.com/before.png)",
          "![After](https://example.com/after.png)",
          "![Duplicate](https://example.com/before.png)",
          "![Local](screenshots/local.png)",
        ].join("\n\n"),
      ),
    );
    expect(result.attachments).toEqual([
      { uri: "https://example.com/before.png", caption: "Before", kind: "image" },
      { uri: "https://example.com/after.png", caption: "After", kind: "image" },
    ]);
    expect(result.preview).toContain("Fixes reconnects.");
    expect(result.preview).not.toContain("Duplicate");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";

describe("pull request description content", () => {
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

  it("reads formatted prose and list items without leaking hidden HTML metadata", () => {
    const result = pullRequestDescriptionContent(
      parseMarkdownDocument(
        "<!-- bot metadata -->\n\nKeeps **sessions**\nalive.\n\n- Reconnect\n- Restore output",
      ),
    );
    expect(result.preview).toBe("Keeps sessions\nalive.\nReconnect\n\nRestore output");
  });
});

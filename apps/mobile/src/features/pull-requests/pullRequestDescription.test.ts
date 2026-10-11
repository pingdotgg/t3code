import { describe, expect, it } from "vite-plus/test";
import { pullRequestDescriptionContent } from "./pullRequestDescriptionContent";

describe("PR description overview", () => {
  it("keeps screenshots in source order, deduplicates embeds, and ignores code and local paths", () => {
    const result = pullRequestDescriptionContent({
      type: "document",
      children: [
        { type: "paragraph", children: [{ type: "text", content: "Fixes reconnects." }] },
        { type: "code_block", content: "![Example](https://example.com/code.png)" },
        { type: "image", href: "https://example.com/before.png", alt: "Before" },
        { type: "image", href: "https://example.com/after.png", alt: "After" },
        { type: "image", href: "https://example.com/before.png", alt: "Duplicate" },
        { type: "image", href: "screenshots/local.png" },
      ],
    });
    expect(result.attachments).toEqual([
      { uri: "https://example.com/before.png", caption: "Before", kind: "image" },
      { uri: "https://example.com/after.png", caption: "After", kind: "image" },
    ]);
    expect(result.preview).toContain("Fixes reconnects.");
    expect(result.preview).not.toContain("Duplicate");
  });

  it("reads formatted prose and list items without leaking hidden HTML metadata", () => {
    const result = pullRequestDescriptionContent({
      type: "document",
      children: [
        { type: "html_block", content: "<!-- bot metadata -->" },
        {
          type: "paragraph",
          children: [
            { type: "text", content: "Keeps " },
            { type: "bold", children: [{ type: "text", content: "sessions" }] },
            { type: "soft_break" },
            { type: "text", content: "alive." },
          ],
        },
        {
          type: "list",
          children: [
            { type: "list_item", children: [{ type: "text", content: "Reconnect" }] },
            { type: "list_item", children: [{ type: "text", content: "Restore output" }] },
          ],
        },
      ],
    });
    expect(result.preview).toBe("Keeps sessions alive.\nReconnect\nRestore output");
  });
});

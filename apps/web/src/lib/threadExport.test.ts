import { describe, expect, it } from "vite-plus/test";

import { formatThreadToMarkdown } from "./threadExport";

describe("formatThreadToMarkdown", () => {
  it("formats a thread with user and assistant turns to clean markdown", () => {
    const md = formatThreadToMarkdown(
      {
        id: "thread-abc-123",
        title: "Feature Discussion",
        createdAt: "2026-09-14T00:00:00.000Z",
        modelSelection: { instanceId: "anthropic", model: "claude-3-7-sonnet" },
        messages: [
          { role: "user", text: "How do I implement export in T3?" },
          {
            role: "assistant",
            text: "You can format the messages to markdown and trigger a download.",
          },
        ],
      },
      "T3 Code",
    );

    expect(md).toContain("# Feature Discussion");
    expect(md).toContain("- **Project:** T3 Code");
    expect(md).toContain("- **Thread ID:** `thread-abc-123`");
    expect(md).toContain("- **Model:** `anthropic/claude-3-7-sonnet`");
    expect(md).toContain("### 👤 User\n\nHow do I implement export in T3?");
    expect(md).toContain(
      "### 🤖 Assistant\n\nYou can format the messages to markdown and trigger a download.",
    );
  });

  it("handles threads without model or project gracefully", () => {
    const md = formatThreadToMarkdown({
      id: "thread-xyz",
      title: "Untitled",
      messages: [],
    });

    expect(md).toContain("# Untitled");
    expect(md).toContain("- **Thread ID:** `thread-xyz`");
    expect(md).not.toContain("- **Project:**");
    expect(md).not.toContain("- **Model:**");
  });

  it("includes partial export warning when isPartial is true", () => {
    const md = formatThreadToMarkdown(
      {
        id: "thread-partial",
        title: "Long Thread",
        messages: [{ role: "user", text: "Latest message" }],
      },
      "T3 Code",
      { isPartial: true },
    );

    expect(md).toContain("> [!WARNING]");
    expect(md).toContain(
      "**Partial Export**: This transcript contains the 1 most recent messages.",
    );
    expect(md).toContain("### 👤 User\n\nLatest message");
  });
});

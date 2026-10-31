import { describe, expect, it } from "vite-plus/test";
import { ChatAttachmentId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { formatThreadTitleContext } from "./threadTitleContext.ts";

describe("thread title context", () => {
  it.each(["", "Ultrathink:\n"])("keeps attachments without bootstrap text (%j)", (prefix) => {
    const attachments = [
      {
        type: "image" as const,
        id: ChatAttachmentId.make("diagram"),
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 10,
      },
    ];
    const text = prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;
    expect(formatThreadTitleContext([{ role: "user", text, attachments }])).toEqual({
      message: "USER:\n[Attachments: diagram.png]",
      attachments,
    });
    expect(formatThreadTitleContext([{ role: "user", text }])).toEqual({
      message: "",
      attachments: [],
    });
  });

  it("keeps a user's scope change despite long assistant output", () => {
    const result = formatThreadTitleContext([
      { role: "user", text: "Review QR sharing" },
      { role: "assistant", text: "Old findings. ".repeat(2_000) },
      { role: "user", text: "Focus on pairing expiry instead. Keep remote access working." },
      { role: "assistant", text: "Implementation details. ".repeat(2_000) },
      { role: "user", text: "Merge it when green." },
    ]);
    expect(result.message.length).toBeLessThanOrEqual(8_000);
    expect(result.message).toContain("USER:\nReview QR sharing");
    expect(result.message).toContain(
      "USER:\nFocus on pairing expiry instead. Keep remote access working.",
    );
    expect(result.message).toContain("USER:\nMerge it when green.");
    expect(result.message).toContain("ASSISTANT:\nImplementation details.");
  });

  it("retains both ends and role labels in long user messages", () => {
    const result = formatThreadTitleContext([
      { role: "system", text: "System instructions" },
      { role: "user", text: `Fix Android pairing. ${"logs ".repeat(3_000)}Keep iOS behavior.` },
      { role: "assistant", text: "Found the cause." },
    ]);
    expect(result.message).toContain("USER:\nFix Android pairing.");
    expect(result.message).toContain("Keep iOS behavior.");
    expect(result.message).toContain("ASSISTANT:\nFound the cause.");
    expect(result.message).not.toContain("System instructions");
    expect(result.message.match(/USER:/g)).toHaveLength(1);
  });
});

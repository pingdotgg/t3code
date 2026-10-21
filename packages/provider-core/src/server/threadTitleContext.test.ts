import { describe, expect, it } from "vite-plus/test";
import { formatThreadTitleContext } from "./threadTitleContext.ts";

describe("thread title context", () => {
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

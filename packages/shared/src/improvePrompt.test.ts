import { describe, expect, it } from "vite-plus/test";

import { buildHandoffMessage, buildImproveRequest, cleanImprovedPrompt, recentConversation } from "./improvePrompt.ts";

describe("improve prompt", () => {
  it("carries decisions from the conversation and the multiline draft verbatim", () => {
    const request = buildImproveRequest({
      draft: "add retries\n- keep the public API\n- max 3",
      threadTitle: "Fix flaky upload",
      projectName: "uploader",
      workingDirectory: "/work/uploader",
      branch: "fix/upload",
      destinationLabel: "Codex · GPT-5.5",
      messages: [
        { role: "user", text: "We decided to keep exponential backoff in uploadClient.ts." },
        { role: "assistant", text: "Agreed; uploadClient.ts owns retries." },
      ],
    });
    expect(request).toContain("<<<DRAFT\nadd retries\n- keep the public API\n- max 3\nDRAFT>>>");
    expect(request).toContain("uploadClient.ts owns retries");
    expect(request).toContain("Receiving agent: Codex · GPT-5.5");
  });

  it("keeps the newest messages within the budget", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({ role: "user" as const, text: `message ${index} ${"x".repeat(900)}` }));
    const kept = recentConversation(messages, 5_000);
    expect(kept.at(-1)?.text.startsWith("message 39")).toBe(true);
    expect(kept.length).toBeLessThan(10);
  });

  it("strips wrappers models add and treats empty output as a failure", () => {
    expect(cleanImprovedPrompt("```markdown\nDo X.\nThen Y.\n```")).toBe("Do X.\nThen Y.");
    expect(cleanImprovedPrompt("Here is the improved prompt: Do X.")).toBe("Do X.");
    expect(cleanImprovedPrompt("   ")).toBe("");
  });

  it("puts the improved prompt first and quotes the original", () => {
    const message = buildHandoffMessage({
      improvedPrompt: "Add bounded retries to uploadClient.ts.",
      originalPrompt: "add retries\nmax 3",
      summary: "- User: keep backoff",
      sourceTitle: "Fix flaky upload",
    });
    expect(message.startsWith("Add bounded retries")).toBe(true);
    expect(message).toContain("> add retries\n> max 3");
    expect(message).toContain('session "Fix flaky upload"');
  });
});

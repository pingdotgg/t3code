import { describe, expect, it } from "vitest";
import { buildThreadHandoffMarkdown } from "./threadHandoff.ts";

describe("buildThreadHandoffMarkdown", () => {
  it("generates structured handoff from Claude to Codex with full context", () => {
    const markdown = buildThreadHandoffMarkdown({
      thread: {
        id: "thread-123",
        title: "Implement Antigravity driver",
        branch: "feat/antigravity",
        worktreePath: null,
        modelSelection: {
          instanceId: "claudeAgent",
          model: "claude-3-7-sonnet",
        },
        messages: [
          {
            role: "user",
            text: "Create the Antigravity driver and fix the process cleanup.",
          },
          {
            role: "assistant",
            text: "I implemented AntigravityAdapter and added unit tests in AntigravityAdapter.test.ts.",
          },
          {
            role: "user",
            text: "Now make sure turn interruption emits turn.completed with state interrupted.",
          },
        ],
        activities: [
          {
            tone: "tool",
            kind: "file",
            summary: "Edited AntigravityAdapter.ts",
            payload: { filePath: "apps/server/src/provider/Layers/AntigravityAdapter.ts" },
          },
          {
            tone: "tool",
            kind: "terminal",
            summary: "pnpm test run AntigravityAdapter.test.ts",
          },
        ],
        proposedPlans: [
          {
            planMarkdown: "- [x] Add AntigravityAdapter\n- [ ] Update interruptTurn logic",
          },
        ],
        checkpoints: [
          {
            files: [
              {
                path: "apps/server/src/provider/Layers/AntigravityAdapter.ts",
                additions: 50,
                deletions: 10,
              },
            ],
          },
        ],
      },
      targetModelSelection: {
        instanceId: "codex",
        model: "gpt-5.3-codex",
      },
    });

    expect(markdown).toContain("# Task Continuation Context");
    expect(markdown).toContain(
      "Continuing from **claudeAgent (claude-3-7-sonnet)** to **codex (gpt-5.3-codex)**.",
    );
    expect(markdown).toContain('Source thread: "Implement Antigravity driver" (ID: `thread-123`)');
    expect(markdown).toContain("## 🎯 Original Goal & Instructions");
    expect(markdown).toContain("Create the Antigravity driver and fix the process cleanup.");
    expect(markdown).toContain("## 📝 Work Completed & Key Decisions");
    expect(markdown).toContain("I implemented AntigravityAdapter and added unit tests");
    expect(markdown).toContain("## 📂 Modified & Relevant Files");
    expect(markdown).toContain("- `apps/server/src/provider/Layers/AntigravityAdapter.ts`");
    expect(markdown).toContain("## ⚙️ Key Actions & Commands Executed");
    expect(markdown).toContain("- pnpm test run AntigravityAdapter.test.ts");
    expect(markdown).toContain("## 📋 Execution Plan");
    expect(markdown).toContain("- [x] Add AntigravityAdapter");
    expect(markdown).toContain("## ⏭️ Latest Request / Next Immediate Step");
    expect(markdown).toContain(
      "Now make sure turn interruption emits turn.completed with state interrupted.",
    );
  });

  it("handles Codex to Claude transition cleanly", () => {
    const markdown = buildThreadHandoffMarkdown({
      thread: {
        id: "thread-456",
        title: "Fix Linux dock icon",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.3-codex",
        },
        messages: [
          {
            role: "user",
            text: "Fix the Linux dock icon grouping in Electron.",
          },
        ],
      },
      targetModelSelection: {
        instanceId: "claudeAgent",
        model: "claude-3-7-sonnet",
      },
    });

    expect(markdown).toContain(
      "Continuing from **codex (gpt-5.3-codex)** to **claudeAgent (claude-3-7-sonnet)**.",
    );
    expect(markdown).toContain("Fix the Linux dock icon grouping in Electron.");
  });

  it("handles source thread with missing model or offline provider", () => {
    const markdown = buildThreadHandoffMarkdown({
      thread: {
        id: "thread-789",
        title: "Offline source thread",
        modelSelection: null,
        messages: [
          {
            role: "user",
            text: "Initial prompt before provider crash.",
          },
        ],
      },
      targetModelSelection: {
        instanceId: "antigravity",
        model: "gemini-3.7-flash",
      },
    });

    expect(markdown).toContain(
      "Continuing from **previous model** to **antigravity (gemini-3.7-flash)**.",
    );
    expect(markdown).toContain("Initial prompt before provider crash.");
  });
});

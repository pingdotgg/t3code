import { describe, expect, it } from "vite-plus/test";

import { MAX_IMPORTED_MESSAGES } from "./AgentSessionScanner.ts";
import { parseClaudeExportTranscript } from "./ClaudeExportTranscript.ts";

const EXPORT = [
  "╭───────────────────────────────────────────────────╮",
  "│ ✻ Welcome to Claude Code!                         │",
  "│   cwd: /home/alice/project                        │",
  "╰───────────────────────────────────────────────────╯",
  "",
  "> /model ",
  "  ⎿  Set model to Opus",
  "",
  "> Why do the tests fail?",
  "  Only on CI.",
  "",
  "✻ Thinking…",
  "",
  "  The user wants the CI failure explained.",
  "",
  "⏺ I'll look at the failing test first.",
  "",
  "⏺ Bash(vp test run apps/server/src/foo.test.ts",
  "      --reporter verbose)",
  "  ⎿  FAIL  foo.test.ts",
  "     Expected 1, received 2",
  "",
  "⏺ The fixture depends on the timezone.",
  "",
  "  - CI runs in UTC",
  "  - Your machine does not",
  "",
  "═══════════════ Conversation compacted · ctrl+o for history ═══════════════",
  "  ⎿  Read apps/server/src/foo.test.ts (40 lines)",
  "",
  "> Fix it",
  "  ⎿  UserPromptSubmit hook succeeded",
  "",
  "● Pinned the clock to UTC.",
  "",
].join("\r\n");

describe("parseClaudeExportTranscript", () => {
  it("keeps prompts and answers and drops tool calls, thinking, and local commands", () => {
    expect(parseClaudeExportTranscript(EXPORT)).toEqual({
      title: "Why do the tests fail?",
      messages: [
        { role: "user", text: "Why do the tests fail?\nOnly on CI." },
        {
          role: "assistant",
          text: [
            "I'll look at the failing test first.",
            "",
            "The fixture depends on the timezone.",
            "",
            "- CI runs in UTC",
            "- Your machine does not",
          ].join("\n"),
        },
        { role: "user", text: "Fix it" },
        { role: "assistant", text: "Pinned the clock to UTC." },
      ],
    });
  });

  it("rejects files without a prompt", () => {
    expect(parseClaudeExportTranscript("")).toBeNull();
    expect(parseClaudeExportTranscript("⏺ Only an answer\n")).toBeNull();
  });

  it("keeps the first prompt and the newest messages", () => {
    const turns = Array.from(
      { length: MAX_IMPORTED_MESSAGES },
      (_, index) => `> prompt ${index}\n\n⏺ answer ${index}\n`,
    );
    const messages = parseClaudeExportTranscript(turns.join("\n"))?.messages ?? [];
    expect(messages).toHaveLength(MAX_IMPORTED_MESSAGES);
    expect(messages[0]).toEqual({ role: "user", text: "prompt 0" });
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      text: `answer ${MAX_IMPORTED_MESSAGES - 1}`,
    });
  });
});

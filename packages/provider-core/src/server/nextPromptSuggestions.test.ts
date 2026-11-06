import { assert, describe, it } from "@effect/vitest";

import {
  buildNextPromptSuggestionsPrompt,
  parseReplyOptions,
  sanitizeNextPromptSuggestions,
  type NextPromptCommand,
} from "./nextPromptSuggestions.ts";

const commands: ReadonlyArray<NextPromptCommand> = [
  {
    name: "what-did-you-learn",
    kind: "skill",
    description: "Use when Ryan asks what you learned.",
  },
  { name: "code-review", kind: "command" },
];

describe("sanitizeNextPromptSuggestions", () => {
  it("keeps listed skills and commands under their exact names and drops invented ones", () => {
    assert.deepEqual(
      sanitizeNextPromptSuggestions(
        [
          { text: "Install it now.", kind: "prompt" },
          { text: "/Code-Review", kind: "command" },
          { text: "$what-did-you-learn", kind: "skill" },
          { text: "deploy-everything", kind: "skill" },
        ],
        commands,
      ),
      [
        { text: "Install it now.", kind: "prompt" },
        { text: "code-review", kind: "command" },
        { text: "what-did-you-learn", kind: "skill" },
      ],
    );
  });

  it("drops quotes, blanks and duplicates, and keeps at most four", () => {
    assert.deepEqual(
      sanitizeNextPromptSuggestions(
        [
          { text: '"Show me a screenshot"', kind: "prompt" },
          { text: "show me a screenshot", kind: "prompt" },
          { text: "   ", kind: "prompt" },
          { text: "One", kind: "prompt" },
          { text: "Two", kind: "prompt" },
          { text: "Three", kind: "prompt" },
        ],
        commands,
      ),
      [
        { text: "Show me a screenshot", kind: "prompt" },
        { text: "One", kind: "prompt" },
        { text: "Two", kind: "prompt" },
        { text: "Three", kind: "prompt" },
      ],
    );
  });

  it("files a command the model labelled as a skill under its real kind", () => {
    assert.deepEqual(
      sanitizeNextPromptSuggestions([{ text: "code-review", kind: "skill" }], commands),
      [{ text: "code-review", kind: "command" }],
    );
  });
});

describe("parseReplyOptions", () => {
  it("reads the last options block, keeping each line as written", () => {
    const reply = [
      "Here is an example of the format:",
      "```options",
      "Old option",
      "```",
      "",
      "Which install should I do?",
      "",
      "```options",
      "- Install now",
      "2. Wait for the other chat",
      "",
      "/code-review",
      "$what-did-you-learn",
      "/code-review high",
      "```",
    ].join("\n");
    assert.deepEqual(parseReplyOptions(reply, commands), [
      { text: "Install now", kind: "prompt" },
      { text: "Wait for the other chat", kind: "prompt" },
      { text: "code-review", kind: "command" },
      { text: "what-did-you-learn", kind: "skill" },
    ]);
  });

  it("sends an unknown command and a fifth option as plain text or not at all", () => {
    const reply = "Pick one.\n~~~options\n/deploy-everything\nA\nB\nC\nD\n~~~";
    assert.deepEqual(parseReplyOptions(reply, commands), [
      { text: "/deploy-everything", kind: "prompt" },
      { text: "A", kind: "prompt" },
      { text: "B", kind: "prompt" },
      { text: "C", kind: "prompt" },
    ]);
  });

  it("returns null without a closed, non-empty options block", () => {
    assert.isNull(parseReplyOptions("No options here.", commands));
    assert.isNull(parseReplyOptions("```options\nStill streaming", commands));
    assert.isNull(parseReplyOptions("```options\n\n```", commands));
    assert.isNull(parseReplyOptions("```ts\nconst options = 1;\n```", commands));
  });
});

describe("buildNextPromptSuggestionsPrompt", () => {
  it("lists the commands and keeps the end of a long reply", () => {
    const { prompt } = buildNextPromptSuggestionsPrompt({
      cwd: "/tmp",
      userMessage: "Build it",
      assistantReply: `${"x".repeat(10_000)} Should I install it now?`,
      commands,
      modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" } as never,
    });
    assert.include(prompt, "- skill what-did-you-learn: Use when Ryan asks what you learned.");
    assert.include(prompt, "- command code-review");
    assert.include(prompt, "Should I install it now?");
    assert.isBelow(prompt.length, 9_000);
  });
});

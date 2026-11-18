import { assert, describe, it } from "@effect/vitest";

import { parseClaudeSessionLogContext } from "./claudeSessionLogContext.ts";

const record = (attachment: object, rest: object = {}) =>
  JSON.stringify({
    type: "attachment",
    attachment,
    timestamp: "2026-01-02T03:04:05.000Z",
    ...rest,
  });

describe("parseClaudeSessionLogContext", () => {
  it("returns every attachment sent as text and each system prompt, in order", () => {
    const parsed = parseClaudeSessionLogContext([
      JSON.stringify({ type: "user", message: { content: 'mentions "attachment"' } }),
      record(
        { type: "hook_success", hookName: "SessionStart:startup", stdout: "raw" },
        { rendered: [{ content: "hook says hi" }], renderedRole: "system" },
      ),
      record(
        { type: "instructions", files: [{}, {}] },
        { rendered: [{ content: "follow the rules" }], renderedRole: "user" },
      ),
      record({ type: "credential_org" }),
      '{"type":"attachment","attachment":{"type":"date"',
      record({ type: "brand_new_kind" }, { rendered: [{ content: "one" }, { content: "two" }] }),
      record({ type: "prompt_snapshot", systemPrompt: ["first block", "second block"] }),
    ]);

    assert.deepStrictEqual(parsed, {
      attachmentRecords: 5,
      entries: [
        {
          kind: "context",
          label: "hook SessionStart:startup",
          role: "system",
          text: "hook says hi",
          timestamp: "2026-01-02T03:04:05.000Z",
        },
        {
          kind: "context",
          label: "instruction files (2)",
          role: "user",
          text: "follow the rules",
          timestamp: "2026-01-02T03:04:05.000Z",
        },
        {
          kind: "context",
          label: "brand_new_kind",
          role: "unknown",
          text: "one\n\ntwo",
          timestamp: "2026-01-02T03:04:05.000Z",
        },
        {
          kind: "systemPrompt",
          blocks: ["first block", "second block"],
          text: "first block\n\nsecond block",
          timestamp: "2026-01-02T03:04:05.000Z",
        },
      ],
    });
  });
});

import { assert, describe, it } from "@effect/vitest";
import type { RequestRewriteRule } from "@t3tools/contracts";

import { rewriteClaudeRequest } from "./claudeRequestRules.ts";

const BILLING = "x-anthropic-billing-header: cc_version=1;";
const IDENTITY = "You are a Claude agent.";
const cache = { type: "ephemeral" };

const request = () => ({
  model: "claude-haiku-5-5",
  system: [
    { type: "text", text: BILLING },
    { type: "text", text: IDENTITY, cache_control: cache },
    { type: "text", text: "Main prompt. Be terse.", cache_control: cache },
  ],
  tools: [{ name: "Bash", description: "Run a command. Careful.", input_schema: {} }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>Remember X</system-reminder>" },
        { type: "text", text: "hello" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    { role: "user", content: [{ type: "text", text: "<system-reminder>only</system-reminder>" }] },
    { role: "user", content: "next question" },
  ],
});

let ids = 0;
const rule = (
  fields: Pick<RequestRewriteRule, "action" | "target"> & Partial<RequestRewriteRule>,
): RequestRewriteRule => ({ id: `rule-${(ids += 1)}`, name: "Rule", enabled: true, ...fields });

const run = (
  rules: ReadonlyArray<RequestRewriteRule>,
  body: string = JSON.stringify(request()),
  path = "/v1/messages?beta=true",
) => rewriteClaudeRequest({ method: "POST", path, body, rules });

const sent = (result: { readonly body: string }) => JSON.parse(result.body);

describe("rewriteClaudeRequest", () => {
  it("removes and replaces text in each target and counts what changed", () => {
    const system = run([rule({ action: "remove", target: "system", pattern: " Be terse\\." })]);
    assert.strictEqual(sent(system).system[2].text, "Main prompt.");
    assert.deepInclude(system.rules[0], { blocks: 1, removedChars: 10, addedChars: 0 });
    assert.deepEqual(system.rules[0]?.warnings, ["cache-breakpoint"]);

    const tools = run([
      rule({ action: "replace", target: "tools", pattern: "Run (a command)", text: "Execute $1" }),
    ]);
    assert.strictEqual(sent(tools).tools[0].description, "Execute a command. Careful.");
    assert.deepInclude(tools.rules[0], { blocks: 1, removedChars: 13, addedChars: 17 });
    assert.deepEqual(tools.rules[0]?.snippets, [
      { before: "Run a command. Careful.", after: "Execute a command. Careful." },
    ]);

    const messages = run([
      rule({ action: "replace", target: "messages", pattern: "next|hi", text: "last" }),
    ]);
    assert.strictEqual(sent(messages).messages[3].content, "last question");
    assert.strictEqual(sent(messages).messages[1].content[0].text, "last there");
    assert.strictEqual(messages.rules[0]?.blocks, 2);
  });

  it("drops reminder blocks left empty and messages left without content", () => {
    const result = run([rule({ action: "remove", target: "reminders", pattern: "[\\s\\S]*" })]);
    const messages = sent(result).messages;
    assert.deepEqual(messages[0].content, [{ type: "text", text: "hello" }]);
    assert.deepEqual(
      messages.map((message: { readonly role: string }) => message.role),
      ["user", "assistant", "user"],
    );
    assert.strictEqual(messages[2].content, "next question");
    assert.deepInclude(result.rules[0], { blocks: 2, warnings: [] });
  });

  it("adds a block to the end of the system prompt or the latest user message", () => {
    const result = run([
      rule({ action: "add", target: "system", text: "Added rule." }),
      rule({ action: "add", target: "messages", text: "Added note." }),
    ]);
    const body = sent(result);
    assert.deepEqual(body.system.at(-1), { type: "text", text: "Added rule." });
    assert.deepEqual(body.messages[3].content, [
      { type: "text", text: "next question" },
      { type: "text", text: "Added note." },
    ]);
    assert.deepEqual(
      result.rules.map((report) => [report.blocks, report.addedChars, report.warnings]),
      [
        [1, 11, []],
        [1, 11, []],
      ],
    );
  });

  it("reports a rule that cannot run, skips it and keeps the body byte-identical", () => {
    const original = JSON.stringify(request(), null, 2);
    const result = run(
      [
        rule({ action: "remove", target: "system", pattern: "(" }),
        rule({ action: "replace", target: "messages" }),
        rule({ action: "add", target: "tools", text: "x" }),
        rule({ action: "remove", target: "messages", pattern: "absent" }),
      ],
      original,
    );
    assert.strictEqual(result.body, original);
    assert.isFalse(result.changed);
    assert.deepEqual(
      result.rules.map((report) => report.error),
      ["invalid-pattern", "missing-pattern", "add-to-tools", undefined],
    );
  });

  it("warns from the request that is sent, not from the rule text", () => {
    const replacedBilling = run([
      rule({ action: "replace", target: "system", pattern: "^x-anthropic", text: "y" }),
    ]);
    assert.deepEqual(replacedBilling.rules[0]?.warnings, ["first-system-block"]);

    // The identity line leading is accepted.
    const removedBilling = run([rule({ action: "remove", target: "system", pattern: "^x-.*$" })]);
    assert.strictEqual(sent(removedBilling).system[0].text, IDENTITY);
    assert.deepEqual(removedBilling.rules[0]?.warnings, []);

    const removedAll = run([rule({ action: "remove", target: "system", pattern: "[\\s\\S]+" })]);
    assert.deepEqual(sent(removedAll).system, []);
    assert.deepEqual(removedAll.rules[0]?.warnings, ["system-removed", "cache-breakpoint"]);

    const restored = run([
      rule({ action: "replace", target: "system", pattern: "^x-anthropic", text: "y" }),
      rule({
        action: "replace",
        target: "system",
        pattern: "^y-billing",
        text: "x-anthropic-billing",
      }),
    ]);
    assert.deepEqual(
      restored.rules.map((report) => report.warnings),
      [[], []],
    );
  });

  it("passes other requests and unexpected bodies through untouched", () => {
    const remove = [rule({ action: "remove", target: "messages", pattern: "hello" })];
    const body = JSON.stringify(request());
    for (const [result, skipped] of [
      [run(remove, body, "/v1/messages/count_tokens"), "other-request"],
      [
        rewriteClaudeRequest({ method: "GET", path: "/v1/messages", body, rules: remove }),
        "other-request",
      ],
      [run(remove, "not json"), "not-json"],
      [run(remove, "[1]"), "unexpected-body"],
    ] as const) {
      assert.deepEqual([result.changed, result.skipped, result.rules], [false, skipped, []]);
    }
    assert.strictEqual(run(remove, "not json").body, "not json");
    assert.strictEqual(run([], body).body, body);
  });
});

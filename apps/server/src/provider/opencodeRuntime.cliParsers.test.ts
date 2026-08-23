import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  parseAgentListCliOutput,
  parseModelsCliOutput,
  parseSkillsCliOutput,
} from "./opencodeRuntime.ts";

describe("parseModelsCliOutput", () => {
  it("parses a single model from a single provider", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      JSON.stringify({
        id: "claude-sonnet-4-5",
        providerID: "anthropic",
        name: "Claude Sonnet 4.5",
        capabilities: { temperature: true, reasoning: true, toolcall: true },
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-01-01",
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    NodeAssert.equal(result.connected.length, 1);
    NodeAssert.equal(result.connected[0], "anthropic");

    const provider = result.providers.get("anthropic")!;
    NodeAssert.ok(provider);
    NodeAssert.equal(provider.id, "anthropic");
    NodeAssert.equal(provider.name, "anthropic");
    NodeAssert.equal(Object.keys(provider.models).length, 1);

    const model = provider.models["claude-sonnet-4-5"]!;
    NodeAssert.ok(model);
    NodeAssert.equal(model.id, "claude-sonnet-4-5");
    NodeAssert.equal(model.providerID, "anthropic");
    NodeAssert.equal(model.name, "Claude Sonnet 4.5");
  });

  it("parses multiple models from multiple providers", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic", name: "Sonnet 4.5" }),
      "anthropic/claude-haiku-4-5",
      JSON.stringify({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Haiku 4.5" }),
      "openai/gpt-4o",
      JSON.stringify({ id: "gpt-4o", providerID: "openai", name: "GPT-4o" }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 2);
    NodeAssert.equal(result.connected.length, 2);
    NodeAssert.equal([...result.connected].sort().join(","), "anthropic,openai");
    NodeAssert.equal(Object.keys(result.providers.get("anthropic")!.models).length, 2);
    NodeAssert.equal(Object.keys(result.providers.get("openai")!.models).length, 1);
  });

  it("handles empty input", () => {
    const result = parseModelsCliOutput("");
    NodeAssert.equal(result.providers.size, 0);
    NodeAssert.equal(result.connected.length, 0);
  });

  it("skips unparseable JSON blocks", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      "this is not valid json {{{",
      "anthropic/claude-haiku-4-5",
      JSON.stringify({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Haiku 4.5" }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    const provider = result.providers.get("anthropic")!;
    NodeAssert.equal(Object.keys(provider.models).length, 1);
    NodeAssert.ok(provider.models["claude-haiku-4-5"]);
  });

  it("handles Windows-style CRLF line endings", () => {
    const stdout =
      "anthropic/claude-sonnet-4-5\r\n" +
      JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic", name: "Sonnet" }) +
      "\r\n";

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    NodeAssert.ok(result.providers.get("anthropic")!.models["claude-sonnet-4-5"]);
  });

  it("handles model JSON with variants and nested fields", () => {
    const stdout = [
      "opencode/gpt-5.4",
      JSON.stringify({
        id: "gpt-5.4",
        providerID: "opencode",
        name: "GPT-5.4",
        family: "gpt",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200000, input: 160000, output: 32000 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-01-01",
        variants: { none: {}, low: {}, medium: {}, high: {} },
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    const model = result.providers.get("opencode")!.models["gpt-5.4"]!;
    NodeAssert.ok(model);
    NodeAssert.ok(model.capabilities);
    NodeAssert.equal(model.capabilities!.reasoning, true);
    NodeAssert.ok(model.variants);
    NodeAssert.equal(model.variants!["medium"] !== undefined, true);
  });

  it("keeps a model whose JSON body has a slash and no interior whitespace", () => {
    // OpenRouter-style: the model id contains a `/` and no string value has a
    // space, so the JSON body line itself matches the slug regex. It must still
    // be treated as the body of the preceding slug, not a new slug.
    const stdout = [
      "openrouter/qwen/qwen3-coder",
      JSON.stringify({
        id: "qwen/qwen3-coder",
        providerID: "openrouter",
        name: "qwen3-coder",
        status: "active",
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    NodeAssert.deepEqual([...result.connected], ["openrouter"]);
    const provider = result.providers.get("openrouter")!;
    NodeAssert.ok(provider);
    const model = provider.models["qwen/qwen3-coder"]!;
    NodeAssert.ok(model);
    NodeAssert.equal(model.id, "qwen/qwen3-coder");
    NodeAssert.equal(model.providerID, "openrouter");
  });
});

describe("parseAgentListCliOutput", () => {
  it("parses a single agent", () => {
    const stdout = [
      "build (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.name, "build");
    NodeAssert.equal(result[0]!.mode, "primary");
    NodeAssert.equal(result[0]!.permission.length, 1);
  });

  it("parses multiple agents", () => {
    const stdout = [
      "build (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
      "explore (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
      "plan (primary)",
      "  " + JSON.stringify([{ permission: "edit", action: "ask", pattern: "*.md" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 3);
    NodeAssert.equal(result[0]!.name, "build");
    NodeAssert.equal(result[0]!.mode, "primary");
    NodeAssert.equal(result[1]!.name, "explore");
    NodeAssert.equal(result[1]!.mode, "subagent");
    NodeAssert.equal(result[2]!.name, "plan");
    NodeAssert.equal(result[2]!.mode, "primary");
  });

  it("handles empty input", () => {
    const result = parseAgentListCliOutput("");
    NodeAssert.equal(result.length, 0);
  });

  it("skips agents with unparseable permission JSON", () => {
    const stdout = [
      "build (primary)",
      "  not valid json {",
      "explore (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.name, "explore");
  });

  it("handles real-world permission blocks with nested paths", () => {
    const permissions = [
      { permission: "*", action: "allow", pattern: "*" },
      {
        permission: "external_directory",
        pattern: "C:\\Users\\test\\.local\\*",
        action: "allow",
      },
      { permission: "read", pattern: "*.env", action: "ask" },
    ];
    const stdout = ["build (primary)", "  " + JSON.stringify(permissions)].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.permission.length, 3);
    NodeAssert.equal(result[0]!.permission[0]!.action, "allow");
    NodeAssert.equal(result[0]!.permission[2]!.action, "ask");
  });

  it("handles agent names with spaces", () => {
    const stdout = [
      "code reviewer (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
      "my custom agent (primary)",
      "  " + JSON.stringify([{ permission: "edit", action: "ask", pattern: "*.ts" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 2);
    NodeAssert.equal(result[0]!.name, "code reviewer");
    NodeAssert.equal(result[0]!.mode, "subagent");
    NodeAssert.equal(result[1]!.name, "my custom agent");
    NodeAssert.equal(result[1]!.mode, "primary");
  });

  it("marks known hidden agents", () => {
    const stdout = [
      "compaction (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
      "build (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result[0]!.hidden, true);
    NodeAssert.equal(result[1]!.hidden, false);
  });
});

describe("terminal escape stripping", () => {
  // opencode <= 1.18 emits `ESC ]0;<cwd>: ready BEL` on stdout for every
  // command, even when stdout is a pipe.
  const OSC_TITLE = "\u001b]0;tmp: ready\u0007";

  it("parseModelsCliOutput ignores an OSC title before the first slug", () => {
    const stdout = [
      `${OSC_TITLE}openai/gpt-4o`,
      JSON.stringify({ id: "gpt-4o", providerID: "openai", name: "GPT-4o" }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.deepEqual([...result.connected], ["openai"]);
    const model = result.providers.get("openai")!.models["gpt-4o"]!;
    NodeAssert.ok(model);
    NodeAssert.equal(model.id, "gpt-4o");
  });

  it("parseAgentListCliOutput strips an OSC title from the agent name", () => {
    const stdout = [
      `${OSC_TITLE}build (primary)`,
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.name, "build");
  });

  it("parseSkillsCliOutput strips an OSC title before the JSON payload", () => {
    const stdout = `${OSC_TITLE}${JSON.stringify([{ name: "review-pr" }])}`;
    NodeAssert.deepEqual(parseSkillsCliOutput(stdout), [{ name: "review-pr" }]);
  });

  it("strips ST-terminated OSC sequences and ANSI color codes", () => {
    const stdout = `\u001b]0;tmp: ready\u001b\\openai/gpt-4o\n${JSON.stringify({
      id: "\u001b[1mgpt-4o\u001b[0m",
      providerID: "openai",
    })}`;

    const result = parseModelsCliOutput(stdout);
    NodeAssert.deepEqual([...result.connected], ["openai"]);
    NodeAssert.equal(result.providers.get("openai")!.models["gpt-4o"]!.id, "gpt-4o");
  });

  it("strips escapes embedded inside decoded model string fields at any depth", () => {
    // JSON.stringify encodes control bytes textually (e.g. `\u001b`), so these
    // survive the byte-level pass over raw stdout and must be stripped after
    // JSON decoding.
    const stdout = [
      "openai/gpt-4o",
      JSON.stringify({
        id: "\u001b]0;pwned\u0007gpt-4o",
        providerID: "openai",
        name: "\u001b[31mGPT-4o\u001b[0m",
        api: {
          id: "\u001b[1mgpt-4o\u001b[0m",
          url: "\u001b]8;;https://x\u001b\\https://x\u001b]8;;\u001b\\",
          npm: "@ai-sdk/openai",
        },
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    const model = result.providers.get("openai")!.models["gpt-4o"]!;
    NodeAssert.equal(model.id, "gpt-4o");
    NodeAssert.equal(model.name, "GPT-4o");
    NodeAssert.equal(model.api.id, "gpt-4o");
    NodeAssert.equal(model.api.url, "https://x");
    NodeAssert.equal(model.providerID, "openai");
  });

  it("keeps unterminated escape prefixes inside decoded model values as literal text", () => {
    // No BEL/ST terminator: stripping must not swallow trailing value text.
    const stdout = [
      "openai/gpt-4o",
      JSON.stringify({
        id: "\u001b]0;partial gpt-4o",
        providerID: "openai",
        name: "GPT-4o",
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    const model = result.providers.get("openai")!.models["gpt-4o"]!;
    NodeAssert.equal(model.id, "\u001b]0;partial gpt-4o");
    NodeAssert.equal(model.name, "GPT-4o");
  });

  it("strips escapes embedded inside decoded agent permission fields", () => {
    const permissions = [
      { permission: "\u001b[31m*\u001b[0m", action: "allow", pattern: "*" },
      {
        permission: "read",
        action: "ask",
        pattern: "\u001b]0;tmp\u0007*.env",
      },
    ];
    const stdout = ["build (primary)", "  " + JSON.stringify(permissions)].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    const agentPermission = result[0]!.permission;
    NodeAssert.deepEqual(agentPermission[0], { permission: "*", action: "allow", pattern: "*" });
    NodeAssert.equal(agentPermission[1]!.pattern, "*.env");
  });

  it("strips escapes embedded inside decoded skill string fields", () => {
    const result = parseSkillsCliOutput(
      JSON.stringify([
        {
          name: "\u001b[1mreview-pr\u001b[0m",
          description: "\u001b]8;;https://git.host/pr/1\u001b\\Review a PR.\u001b]8;;\u001b\\",
          location: "/tmp/review-pr/SKILL.md",
          content: "---\nname: \u001b[32mreview-pr\u001b[0m\n---\n",
        },
      ]),
    );

    NodeAssert.deepEqual(result, [
      {
        name: "review-pr",
        description: "Review a PR.",
        location: "/tmp/review-pr/SKILL.md",
        content: "---\nname: review-pr\n---\n",
      },
    ]);
  });
});

describe("parseSkillsCliOutput", () => {
  it("parses skill metadata from the CLI JSON output", () => {
    const result = parseSkillsCliOutput(
      JSON.stringify([
        {
          name: "review-pr",
          description: "Review a pull request.",
          location: "/tmp/review-pr/SKILL.md",
          content: "---\nname: review-pr\n---\n",
        },
      ]),
    );

    NodeAssert.deepEqual(result, [
      {
        name: "review-pr",
        description: "Review a pull request.",
        location: "/tmp/review-pr/SKILL.md",
        content: "---\nname: review-pr\n---\n",
      },
    ]);
  });

  it("degrades malformed output to an empty skill list", () => {
    NodeAssert.deepEqual(parseSkillsCliOutput("not json"), []);
  });
});

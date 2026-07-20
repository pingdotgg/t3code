import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { parseModelsCliOutput, parseAgentListCliOutput } from "./opencodeRuntime.ts";

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

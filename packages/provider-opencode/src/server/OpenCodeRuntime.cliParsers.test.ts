import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

describe("parseModelsCliOutput", () => {
  it("parses multiple models from multiple providers", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic", name: "Sonnet 4.5" }),
      "anthropic/claude-haiku-4-5",
      JSON.stringify({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Haiku 4.5" }),
      "openai/gpt-4o",
      JSON.stringify({ id: "gpt-4o", providerID: "openai", name: "GPT-4o" }),
    ].join("\n");

    const result = OpenCodeRuntime.parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 2);
    NodeAssert.equal(result.connected.length, 2);
    NodeAssert.equal([...result.connected].sort().join(","), "anthropic,openai");
    NodeAssert.equal(Object.keys(result.providers.get("anthropic")!.models).length, 2);
    NodeAssert.equal(Object.keys(result.providers.get("openai")!.models).length, 1);
  });

  it("skips unparseable JSON blocks", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      "this is not valid json {{{",
      "anthropic/claude-haiku-4-5",
      JSON.stringify({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Haiku 4.5" }),
    ].join("\n");

    const result = OpenCodeRuntime.parseModelsCliOutput(stdout);
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

    const result = OpenCodeRuntime.parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    NodeAssert.ok(result.providers.get("anthropic")!.models["claude-sonnet-4-5"]);
  });

  it("keeps a model whose JSON body has a slash and no interior whitespace", () => {
    const stdout = [
      "openrouter/qwen/qwen3-coder",
      JSON.stringify({
        id: "qwen/qwen3-coder",
        providerID: "openrouter",
        name: "qwen3-coder",
        status: "active",
      }),
    ].join("\n");

    const result = OpenCodeRuntime.parseModelsCliOutput(stdout);
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
  it("skips agents with unparseable permission JSON", () => {
    const stdout = [
      "build (primary)",
      "  not valid json {",
      "explore (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = OpenCodeRuntime.parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.name, "explore");
  });

  it("handles agent names with spaces", () => {
    const stdout = [
      "code reviewer (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
      "my custom agent (primary)",
      "  " + JSON.stringify([{ permission: "edit", action: "ask", pattern: "*.ts" }]),
    ].join("\n");

    const result = OpenCodeRuntime.parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 2);
    NodeAssert.equal(result[0]!.name, "code reviewer");
    NodeAssert.equal(result[0]!.mode, "subagent");
    NodeAssert.equal(result[1]!.name, "my custom agent");
    NodeAssert.equal(result[1]!.mode, "primary");
  });
});

describe("parseSkillsCliOutput", () => {
  it("degrades malformed output to an empty skill list", () => {
    NodeAssert.deepEqual(OpenCodeRuntime.parseSkillsCliOutput("not json"), []);
  });
});

describe("toOpenCodeFileParts", () => {
  const attachment = (mimeType: string, sizeBytes = 12) => ({
    type: "file" as const,
    id: "thread-1-00000000-0000-4000-8000-000000000001-bin",
    name: "attachment",
    mimeType,
    sizeBytes,
  });

  it("sends supported images, text, and PDFs natively and skips what models reject", () => {
    const parts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: [
        attachment("application/pdf"),
        attachment("text/plain"),
        attachment("image/png"),
        // ZIP file parts fail Anthropic before turn start; send only the prompt's path line.
        attachment("application/zip"),
        // OpenCode inlines only text/plain; other text MIME parts fail Anthropic/OpenAI.
        attachment("text/html"),
        attachment("text/markdown"),
        attachment("application/octet-stream"),

        attachment("image/bmp"),
        attachment("image/svg+xml"),

        attachment("application/pdf", 21 * 1024 * 1024),
      ],
      resolveAttachmentPath: () => "/tmp/attachment",
    });

    NodeAssert.deepEqual(
      parts.map((part) => part.mime),
      ["application/pdf", "text/plain", "image/png"],
    );
  });

  it("keeps folded clipboard text on the lazy path fallback", () => {
    const parts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: [
        {
          ...attachment("text/plain"),
          source: { _tag: "pasted-text" as const },
        },
      ],
      resolveAttachmentPath: () => "/tmp/pasted-text.txt",
    });

    NodeAssert.deepEqual(parts, []);
  });
});

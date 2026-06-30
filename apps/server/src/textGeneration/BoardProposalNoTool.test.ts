/**
 * Architectural-safety tests for the no-tool `generateBoardProposal` op.
 *
 * The self-improving-boards meta-agent MUST run with tools/filesystem denied so
 * it physically cannot write a board definition (only the human-gated
 * `saveBoardDefinition` applies a proposal). These tests assert the no-tool
 * guarantee at the layer that BUILDS the provider invocation, plus that the
 * supported providers return a structured `{ proposedDefinition, rationale }`.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildClaudeProposalArgs } from "./ClaudeTextGeneration.ts";
import { buildCodexExecArgs } from "./CodexTextGeneration.ts";
import { buildBoardProposalPrompt } from "./TextGenerationPrompts.ts";
import { toJsonSchemaObject } from "./TextGenerationUtils.ts";

describe("buildCodexExecArgs (Codex no-tool guarantee)", () => {
  const base = {
    model: "gpt-5.5",
    reasoningEffort: "high",
    schemaPath: "/tmp/schema.json",
    outputPath: "/tmp/out.txt",
  } as const;

  it("board-proposal posture ignores the user config (no MCP, hooks, skills, or dev-instructions)", () => {
    const args = buildCodexExecArgs({ ...base, ignoreUserConfig: true });
    // `--ignore-user-config` is the Codex analog of Claude's strict-mcp suppression,
    // and additionally drops config-driven hooks/skills/developer_instructions — the
    // arbitrary-execution surface a no-tool generation must not load. Auth still uses
    // CODEX_HOME; model + effort are passed explicitly on the CLI, so they survive.
    expect(args).toContain("--ignore-user-config");
    // Still sandboxed read-only and pointed at the explicit model/effort.
    const sandboxIndex = args.indexOf("-s");
    expect(args[sandboxIndex + 1]).toBe("read-only");
    expect(args).toContain("--skip-git-repo-check");
    const modelIndex = args.indexOf("--model");
    expect(args[modelIndex + 1]).toBe("gpt-5.5");
  });

  it("git-op posture does NOT ignore the user config (unchanged behavior)", () => {
    const args = buildCodexExecArgs(base);
    expect(args).not.toContain("--ignore-user-config");
  });
});

describe("buildBoardProposalPrompt output schema (provider structured-output validity)", () => {
  // Regression: OpenAI/Codex `text.format.schema` rejects any property that lacks
  // a `type` key with `invalid_json_schema`. `Schema.Unknown` emitted `{}` (no
  // type) for `proposedDefinition`, 400-ing every Codex board proposal. Every
  // property in the wire schema MUST declare a `type`.
  const { outputSchema } = buildBoardProposalPrompt({ prompt: "x" });
  const wire = toJsonSchemaObject(outputSchema) as {
    readonly properties: Record<string, { readonly type?: unknown }>;
  };

  it("gives every top-level property a `type` key", () => {
    for (const [key, sub] of Object.entries(wire.properties)) {
      expect(sub.type, `property "${key}" must declare a type`).toBeTypeOf("string");
    }
  });

  it("models proposedDefinition as a JSON string that decodes back to an object", () => {
    expect(wire.properties.proposedDefinition?.type).toBe("string");
    // The provider returns the whole response as a JSON string; proposedDefinition
    // is itself a JSON-encoded string that must decode into the definition object.
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(outputSchema));
    const decoded = decode(
      JSON.stringify({
        proposedDefinition: JSON.stringify({ name: "X", lanes: [{ key: "a" }] }),
        rationale: "because",
      }),
    ) as { proposedDefinition: unknown; rationale: string };
    expect(decoded.proposedDefinition).toEqual({ name: "X", lanes: [{ key: "a" }] });
    expect(decoded.rationale).toBe("because");
  });
});

describe("buildClaudeProposalArgs (Claude no-tool guarantee)", () => {
  const base = {
    jsonSchemaStr: '{"type":"object"}',
    model: "claude-opus-4-6",
    cliEffort: undefined,
    settingsJson: undefined,
  } as const;

  it("no-tool posture loads ZERO tools (no built-ins AND no MCP) and never skips permissions", () => {
    const args = buildClaudeProposalArgs({ ...base, posture: "no-tool" });

    // --tools "" disables every BUILT-IN tool (see `claude --help`: `--tools`
    // affects "the built-in set" only).
    const toolsIndex = args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(args[toolsIndex + 1]).toBe("");

    // --strict-mcp-config + --mcp-config "{}" suppress ALL MCP-server tools
    // (which --tools "" does NOT cover) regardless of the machine's config.
    expect(args).toContain("--strict-mcp-config");
    const mcpIndex = args.indexOf("--mcp-config");
    expect(mcpIndex).toBeGreaterThanOrEqual(0);
    expect(args[mcpIndex + 1]).toBe("{}");

    // The dangerous tool-granting flag MUST be absent.
    expect(args).not.toContain("--dangerously-skip-permissions");

    // Variadic-safety: `--tools ""` must be the LAST pair so no later flag is
    // swallowed by its empty value. `--strict-mcp-config` (boolean) precedes
    // `--mcp-config "{}"` which precedes `--tools ""`.
    expect(args[args.length - 2]).toBe("--tools");
    expect(args[args.length - 1]).toBe("");
    expect(mcpIndex).toBeLessThan(toolsIndex);
    expect(args.indexOf("--strict-mcp-config")).toBeLessThan(mcpIndex);
  });

  it("skip-permissions posture grants tools (the existing git-op behavior)", () => {
    const args = buildClaudeProposalArgs({ ...base, posture: "skip-permissions" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  it("honors model and effort/settings per call", () => {
    const args = buildClaudeProposalArgs({
      jsonSchemaStr: '{"type":"object"}',
      model: "claude-sonnet-4-6",
      cliEffort: "high",
      settingsJson: '{"alwaysThinkingEnabled":true}',
      posture: "no-tool",
    });
    const modelIndex = args.indexOf("--model");
    expect(args[modelIndex + 1]).toBe("claude-sonnet-4-6");
    const effortIndex = args.indexOf("--effort");
    expect(args[effortIndex + 1]).toBe("high");
    const settingsIndex = args.indexOf("--settings");
    expect(args[settingsIndex + 1]).toBe('{"alwaysThinkingEnabled":true}');
  });
});

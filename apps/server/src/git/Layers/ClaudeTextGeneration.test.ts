import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import type { Query, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";

function makeQueryRuntime(messages: ReadonlyArray<SDKResultMessage>): Query {
  const generator = (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();

  return Object.assign(generator, {
    interrupt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    setMaxThinkingTokens: async () => {},
    applyFlagSettings: async () => {},
    initializationResult: async () => {
      throw new Error("initializationResult is not used in this test");
    },
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    mcpServerStatus: async () => [],
    accountInfo: async () => {
      throw new Error("accountInfo is not used in this test");
    },
    rewindFiles: async () => {
      throw new Error("rewindFiles is not used in this test");
    },
    reconnectMcpServer: async () => {},
    toggleMcpServer: async () => {},
    setMcpServers: async () => ({
      added: [],
      removed: [],
      errors: [],
    }),
    streamInput: async () => {},
    stopTask: async () => {},
    close: () => {},
  }) as unknown as Query;
}

function makeSuccessResult(input: {
  structuredOutput?: unknown;
  result?: string;
}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: input.result ?? "",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    ...(input.structuredOutput !== undefined ? { structured_output: input.structuredOutput } : {}),
    uuid: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
  } as SDKResultMessage;
}

function makeErrorResult(error: string): SDKResultMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    errors: [error],
    uuid: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
  } as SDKResultMessage;
}

it.effect("uses Claude structured output for git commit generation", () => {
  const queryCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const layer = Layer.effect(
    TextGeneration,
    makeClaudeTextGeneration({
      createQuery: (input) => {
        queryCalls.push({
          prompt: input.prompt,
          options: input.options as Record<string, unknown>,
        });
        return makeQueryRuntime([
          makeSuccessResult({
            structuredOutput: {
              subject: "  Add Claude git generation support.\nextra line",
              body: "- update backend routing\n- cover claude path",
            },
          }),
        ]);
      },
    }),
  );

  return Effect.gen(function* () {
    const textGeneration = yield* TextGeneration;
    const generated = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M apps/server/src/git/Layers/RoutingTextGeneration.ts",
      stagedPatch: "diff --git a/apps/server/src/git/Layers/RoutingTextGeneration.ts b/...",
      model: "sonnet",
    });

    expect(generated.subject).toBe("Add Claude git generation support");
    expect(generated.body).toBe("- update backend routing\n- cover claude path");
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options.model).toBe("claude-sonnet-4-6");
    expect(queryCalls[0]?.options.tools).toEqual([]);
    expect(queryCalls[0]?.options.persistSession).toBe(false);
  }).pipe(Effect.provide(layer));
});

it.effect("returns a typed error when Claude generation fails", () => {
  const layer = Layer.effect(
    TextGeneration,
    makeClaudeTextGeneration({
      createQuery: () => makeQueryRuntime([makeErrorResult("authentication failed")]),
    }),
  );

  return Effect.gen(function* () {
    const textGeneration = yield* TextGeneration;
    const result = yield* textGeneration
      .generatePrContent({
        cwd: process.cwd(),
        baseBranch: "main",
        headBranch: "feature/claude",
        commitSummary: "feat: add claude routing",
        diffSummary: "1 file changed",
        diffPatch: "diff --git a/file b/file",
        model: "claude-sonnet-4-6",
      })
      .pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: "Left" as const, left: error }),
          onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
        }),
      );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(TextGenerationError);
      expect(result.left.message).toContain("Claude CLI request failed: authentication failed");
    }
  }).pipe(Effect.provide(layer));
});

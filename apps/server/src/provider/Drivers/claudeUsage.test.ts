import { describe, expect, it } from "@effect/vitest";

import { claudeUsageFormat, parseClaudeLine } from "./claudeUsage.ts";

function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
  speed?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
        ...(overrides.speed === undefined ? {} : { speed: overrides.speed }),
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const [record] = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record).toBeDefined();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
    expect(record?.speed).toBe("standard");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // Content-block records repeat full parent usage; summing them overcounts.
    const [text] = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const [toolUse] = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("skips local placeholders in both reader paths but keeps real zero-token responses", () => {
    const projected = {
      type: "assistant",
      timestamp: "2026-08-07T04:05:13.944Z",
      message: {
        model: "claude-fable-5",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    const expected = [
      expect.objectContaining({
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ];
    expect(claudeUsageFormat.parseLine(JSON.stringify(projected), undefined)).toEqual(expected);
    expect(claudeUsageFormat.parseProjected(projected, undefined)).toEqual(expected);

    const synthetic = { ...projected, message: { ...projected.message, model: "<synthetic>" } };
    expect(claudeUsageFormat.parseLine(JSON.stringify(synthetic), undefined)).toEqual([]);
    expect(claudeUsageFormat.parseProjected(synthetic, undefined)).toEqual([]);
  });
});

describe("Claude advisor iterations", () => {
  const advisorTurn = {
    type: "assistant",
    timestamp: "2026-10-22T01:31:11.984Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 118320,
        cache_creation_input_tokens: 2676,
        output_tokens: 4506,
        speed: "standard",
        iterations: [
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 58352,
            cache_creation_input_tokens: 1616,
            output_tokens: 141,
          },
          {
            type: "advisor_message",
            model: "claude-fable-5-1",
            input_tokens: 54204,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 4229,
          },
          {
            type: "message",
            input_tokens: 2,
            cache_read_input_tokens: 59968,
            cache_creation_input_tokens: 1060,
            output_tokens: 4365,
          },
        ],
      },
    },
  };
  const withIterations = (iterations: readonly unknown[]) => ({
    ...advisorTurn,
    message: { ...advisorTurn.message, usage: { ...advisorTurn.message.usage, iterations } },
  });
  const parse = (turn: unknown) => claudeUsageFormat.parseLine(JSON.stringify(turn), undefined);

  it("reports the advisor model's tokens as their own record beside the unchanged executor record", () => {
    const executor = {
      provider: "claude",
      timestampMs: Date.parse("2026-10-22T01:31:11.984Z"),
      model: "claude-opus-5-5",
      sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
      totals: {
        uncachedInputTokens: 4,
        cachedInputTokens: 118320,
        cacheCreationTokens: 2676,
        outputTokens: 4506,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "msg_1:req_1",
    };
    const expected = [
      executor,
      {
        ...executor,
        model: "claude-fable-5-1",
        totals: {
          uncachedInputTokens: 54204,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 4229,
          reasoningTokens: 0,
        },
        dedupeKey: expect.any(String),
      },
    ];

    expect(parse(advisorTurn)).toEqual(expected);
    expect(claudeUsageFormat.parseProjected(advisorTurn, undefined)).toEqual(expected);
  });

  it("keys the advisor record apart from the executor and the same across a message's content blocks", () => {
    const block = (type: string) =>
      parse({ ...advisorTurn, message: { ...advisorTurn.message, content: [{ type }] } });
    const [executorKey, advisorKey] = block("text").map((record) => record.dedupeKey);

    expect(advisorKey).toEqual(expect.any(String));
    expect(advisorKey).not.toBe(executorKey);
    expect(block("tool_use").map((record) => record.dedupeKey)).toEqual([executorKey, advisorKey]);

    const unkeyed = parse({
      ...advisorTurn,
      requestId: undefined,
      message: { ...advisorTurn.message, id: undefined },
    });
    expect(unkeyed.map((record) => record.dedupeKey)).toEqual([null, null]);
  });

  it("emits only the executor record without an advisor iteration", () => {
    const executorIterations = advisorTurn.message.usage.iterations.filter(
      (iteration) => iteration.type === "message",
    );

    expect(parse(withIterations(executorIterations))).toHaveLength(1);
    expect(claudeUsageFormat.parseProjected(withIterations([]), undefined)).toHaveLength(1);
    expect(
      claudeUsageFormat.parseLine(
        claudeLine({ messageId: "msg_3", contentType: "text" }),
        undefined,
      ),
    ).toHaveLength(1);
  });

  it("ignores advisor iterations without a usable model and malformed entries", () => {
    const unusable = withIterations([
      null,
      "advisor_message",
      { type: "advisor_message", input_tokens: 5 },
      { type: "advisor_message", model: "", input_tokens: 5 },
      { type: "advisor_message", model: "<synthetic>", input_tokens: 5 },
    ]);

    expect(parse(unusable).map((record) => record.model)).toEqual(["claude-opus-5-5"]);
  });
});

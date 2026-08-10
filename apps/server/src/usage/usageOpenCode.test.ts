import { describe, expect, it } from "@effect/vitest";

import { parseOpenCodeMessageData } from "./usageOpenCode.ts";

describe("parseOpenCodeMessageData", () => {
  it("maps assistant message tokens and reported cost", () => {
    const record = parseOpenCodeMessageData(
      JSON.stringify({
        role: "assistant",
        modelID: "grok-4.5",
        cost: 0.00585,
        tokens: {
          input: 47,
          output: 149,
          reasoning: 53,
          cache: { write: 0, read: 9088 },
        },
        time: { created: 1_786_052_197_346 },
      }),
      "msg_1",
      "ses_1",
    );

    expect(record).toEqual({
      provider: "opencode",
      timestampMs: 1_786_052_197_346,
      model: "grok-4.5",
      sessionId: "ses_1",
      totals: {
        uncachedInputTokens: 47,
        cachedInputTokens: 9088,
        cacheCreationTokens: 0,
        outputTokens: 202,
        reasoningTokens: 53,
      },
      reportedCostUsd: 0.00585,
      dedupeKey: "opencode:msg_1",
    });
  });
  it("treats zero cost as unreported so LiteLLM can price it", () => {
    const record = parseOpenCodeMessageData(
      JSON.stringify({
        role: "assistant",
        modelID: "claude-opus-4",
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { write: 2, read: 0 } },
        time: { created: 1_786_052_197_346 },
      }),
      "msg_2",
      "ses_2",
    );

    expect(record?.reportedCostUsd).toBeNull();
    expect(record?.totals.cacheCreationTokens).toBe(2);
  });

  it("ignores non-assistant and empty-token messages", () => {
    expect(
      parseOpenCodeMessageData(
        JSON.stringify({ role: "user", time: { created: 1 } }),
        "msg_u",
        "ses",
      ),
    ).toBeNull();

    expect(
      parseOpenCodeMessageData(
        JSON.stringify({
          role: "assistant",
          modelID: "x",
          tokens: { input: 0, output: 0, reasoning: 0, cache: {} },
          time: { created: 1 },
        }),
        "msg_empty",
        "ses",
      ),
    ).toBeNull();
  });
});

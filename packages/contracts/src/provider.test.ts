import { describe, expect, it } from "vitest";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  providerCheckpointSchema,
  providerEventSchema,
  providerListCheckpointsInputSchema,
  providerListCheckpointsResultSchema,
  providerRevertToCheckpointInputSchema,
  providerRevertToCheckpointResultSchema,
  providerRespondToRequestInputSchema,
  providerSendTurnInputSchema,
  providerSessionStartInputSchema,
} from "./provider";

describe("providerSessionStartInputSchema", () => {
  it("defaults to codex with safe policies", () => {
    const parsed = providerSessionStartInputSchema.parse({});
    expect(parsed.provider).toBe("codex");
    expect(parsed.approvalPolicy).toBe("never");
    expect(parsed.sandboxMode).toBe("workspace-write");
  });

  it("accepts optional resumeThreadId", () => {
    const parsed = providerSessionStartInputSchema.parse({
      resumeThreadId: "thread_123",
    });
    expect(parsed.resumeThreadId).toBe("thread_123");
  });

  it("rejects blank resumeThreadId", () => {
    expect(() =>
      providerSessionStartInputSchema.parse({
        resumeThreadId: "   ",
      }),
    ).toThrow();
  });
});

describe("providerSendTurnInputSchema", () => {
  it("trims input text and optional model/effort", () => {
    const parsed = providerSendTurnInputSchema.parse({
      sessionId: "sess_1",
      input: "  summarize this repo  ",
      model: "  gpt-5.2-codex  ",
      effort: "  high  ",
    });
    expect(parsed.input).toBe("summarize this repo");
    expect(parsed.attachments).toEqual([]);
    expect(parsed.model).toBe("gpt-5.2-codex");
    expect(parsed.effort).toBe("high");
  });

  it("accepts image-only turns", () => {
    const parsed = providerSendTurnInputSchema.parse({
      sessionId: "sess_1",
      attachments: [
        {
          type: "image",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 1_024,
          dataUrl: "data:image/png;base64,AAAA",
        },
      ],
    });
    expect(parsed.input).toBeUndefined();
    expect(parsed.attachments).toHaveLength(1);
  });

  it("rejects turns with neither text nor attachments", () => {
    expect(() =>
      providerSendTurnInputSchema.parse({
        sessionId: "sess_1",
      }),
    ).toThrow();
  });

  it("rejects non-image data urls", () => {
    expect(() =>
      providerSendTurnInputSchema.parse({
        sessionId: "sess_1",
        attachments: [
          {
            type: "image",
            name: "not-image.txt",
            mimeType: "text/plain",
            sizeBytes: 25,
            dataUrl: "data:text/plain;base64,QQ==",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects more than the max attachment count", () => {
    expect(() =>
      providerSendTurnInputSchema.parse({
        sessionId: "sess_1",
        attachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, (_, index) => ({
          type: "image" as const,
          name: `image-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 1_024,
          dataUrl: "data:image/png;base64,AAAA",
        })),
      }),
    ).toThrow();
  });
});

describe("providerEventSchema", () => {
  it("accepts notification events with routing metadata", () => {
    const parsed = providerEventSchema.parse({
      id: "evt_1",
      kind: "notification",
      provider: "codex",
      sessionId: "sess_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      method: "item/agentMessage/delta",
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      textDelta: "hi",
    });
    expect(parsed.method).toBe("item/agentMessage/delta");
  });

  it("accepts request approval metadata", () => {
    const parsed = providerEventSchema.parse({
      id: "evt_2",
      kind: "request",
      provider: "codex",
      sessionId: "sess_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      method: "item/commandExecution/requestApproval",
      requestId: "req_123",
      requestKind: "command",
    });
    expect(parsed.requestId).toBe("req_123");
    expect(parsed.requestKind).toBe("command");
  });
});

describe("providerRespondToRequestInputSchema", () => {
  it("accepts valid decisions", () => {
    const parsed = providerRespondToRequestInputSchema.parse({
      sessionId: "sess_1",
      requestId: "req_1",
      decision: "acceptForSession",
    });
    expect(parsed.decision).toBe("acceptForSession");
  });

  it("rejects unknown decisions", () => {
    expect(() =>
      providerRespondToRequestInputSchema.parse({
        sessionId: "sess_1",
        requestId: "req_1",
        decision: "always",
      }),
    ).toThrow();
  });
});

describe("provider checkpoint schemas", () => {
  it("accepts list checkpoint inputs", () => {
    const parsed = providerListCheckpointsInputSchema.parse({
      sessionId: "sess_1",
    });
    expect(parsed.sessionId).toBe("sess_1");
  });

  it("accepts checkpoint records and list results", () => {
    const checkpoint = providerCheckpointSchema.parse({
      id: "turn_1",
      turnCount: 1,
      messageCount: 2,
      label: "Turn 1",
      preview: "Summarize this file",
      isCurrent: true,
    });
    expect(checkpoint.turnCount).toBe(1);

    const listResult = providerListCheckpointsResultSchema.parse({
      threadId: "thr_1",
      checkpoints: [checkpoint],
    });
    expect(listResult.checkpoints).toHaveLength(1);
  });

  it("accepts revert checkpoint input/result", () => {
    const input = providerRevertToCheckpointInputSchema.parse({
      sessionId: "sess_1",
      turnCount: 2,
    });
    expect(input.turnCount).toBe(2);

    const result = providerRevertToCheckpointResultSchema.parse({
      threadId: "thr_1",
      turnCount: 2,
      messageCount: 4,
      rolledBackTurns: 1,
      checkpoints: [
        {
          id: "root",
          turnCount: 0,
          messageCount: 0,
          label: "Start of conversation",
          isCurrent: false,
        },
        {
          id: "turn_2",
          turnCount: 2,
          messageCount: 4,
          label: "Turn 2",
          isCurrent: true,
        },
      ],
    });
    expect(result.rolledBackTurns).toBe(1);
  });

  it("rejects negative turn counts", () => {
    expect(() =>
      providerRevertToCheckpointInputSchema.parse({
        sessionId: "sess_1",
        turnCount: -1,
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PENDING_REQUEST_MCP_MAX_QUESTION_CHARS,
  PendingRequestMcpListInput,
  PendingRequestMcpReadResult,
  PendingRequestMcpReadInput,
  PendingRequestMcpRespondInput,
} from "./pendingRequestMcp.ts";

const decodeList = Schema.decodeUnknownSync(PendingRequestMcpListInput);
const decodeRead = Schema.decodeUnknownSync(PendingRequestMcpReadInput);
const decodeReadResult = Schema.decodeUnknownSync(PendingRequestMcpReadResult);
const decodeRespond = Schema.decodeUnknownSync(PendingRequestMcpRespondInput);

describe("pending-request MCP contracts", () => {
  it("keeps every operation discoverable as a root object schema", () => {
    for (const schema of [
      PendingRequestMcpListInput,
      PendingRequestMcpReadInput,
      PendingRequestMcpRespondInput,
    ]) {
      expect(Schema.toJsonSchemaDocument(schema).schema.type).toBe("object");
    }
  });

  it("accepts structured text, numeric, boolean, and multiple-choice answers", () => {
    expect(
      decodeRespond({
        childThreadId: "thread:child",
        requestId: "request:questions",
        answers: {
          editor: "vim",
          features: ["queue controls", "attachments"],
          retries: 3,
          confirmed: true,
        },
        clientRequestId: "answer-questions-1",
      }).answers,
    ).toEqual({
      editor: "vim",
      features: ["queue controls", "attachments"],
      retries: 3,
      confirmed: true,
    });
    expect(() =>
      decodeRespond({
        childThreadId: "thread:child",
        requestId: "request:questions",
        answers: { retries: Number.POSITIVE_INFINITY },
      }),
    ).toThrow();
  });

  it("bounds list pages and requires stable target identifiers", () => {
    expect(decodeList({ limit: 50, cursor: "v1:node%3Atask:request%3Aquestion" })).toEqual({
      limit: 50,
      cursor: "v1:node%3Atask:request%3Aquestion",
    });
    expect(() => decodeList({ limit: 51 })).toThrow();
    expect(decodeRead({ childThreadId: "thread:child", requestId: "request:questions" })).toEqual({
      childThreadId: "thread:child",
      requestId: "request:questions",
    });
  });

  it("rejects oversized complete question payloads but represents them explicitly", () => {
    const result = {
      taskId: "node:task",
      childThreadId: "thread:child",
      runId: null,
      nodeId: "node:request",
      requestId: "request:questions",
      providerInstanceId: "codex",
      driverKind: "codex",
      status: "pending",
      resumable: true,
      answerable: true,
      questionCount: 1,
      questionPayloadStatus: "complete",
      questions: [
        {
          id: "editor",
          header: "Editor",
          question: "q".repeat(PENDING_REQUEST_MCP_MAX_QUESTION_CHARS + 1),
          options: [],
        },
      ],
      createdAt: "2026-08-29T12:00:00.000Z",
      resolvedAt: null,
    };
    expect(() => decodeReadResult(result)).toThrow();
    expect(
      decodeReadResult({
        ...result,
        answerable: false,
        questionPayloadStatus: "too_large",
        questions: [],
      }),
    ).toMatchObject({
      requestId: "request:questions",
      questionCount: 1,
      questionPayloadStatus: "too_large",
      questions: [],
    });
  });
});

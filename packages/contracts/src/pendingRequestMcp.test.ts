import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PendingRequestMcpListInput,
  PendingRequestMcpReadInput,
  PendingRequestMcpRespondInput,
} from "./pendingRequestMcp.ts";

const decodeList = Schema.decodeUnknownSync(PendingRequestMcpListInput);
const decodeRead = Schema.decodeUnknownSync(PendingRequestMcpReadInput);
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

  it("accepts structured single and multiple-choice answers", () => {
    expect(
      decodeRespond({
        childThreadId: "thread:child",
        requestId: "request:questions",
        answers: {
          editor: "vim",
          features: ["queue controls", "attachments"],
        },
        clientRequestId: "answer-questions-1",
      }).answers,
    ).toEqual({
      editor: "vim",
      features: ["queue controls", "attachments"],
    });
  });

  it("bounds list pages and requires stable target identifiers", () => {
    expect(decodeList({ limit: 50, cursor: "2:1" })).toEqual({ limit: 50, cursor: "2:1" });
    expect(() => decodeList({ limit: 51 })).toThrow();
    expect(decodeRead({ childThreadId: "thread:child", requestId: "request:questions" })).toEqual({
      childThreadId: "thread:child",
      requestId: "request:questions",
    });
  });
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CheckpointMcpDiffInput,
  CheckpointMcpListInput,
  CheckpointMcpRestoreInput,
  CheckpointScopeId,
  ThreadId,
} from "./index.ts";

const decodeListInput = Schema.decodeUnknownSync(CheckpointMcpListInput);
const decodeDiffInput = Schema.decodeUnknownSync(CheckpointMcpDiffInput);
const decodeRestoreInput = Schema.decodeUnknownSync(CheckpointMcpRestoreInput);

describe("checkpoint MCP contracts", () => {
  it("decodes bounded list and diff inputs from the old empty/default shape", () => {
    expect(decodeListInput({})).toEqual({});
    expect(
      decodeDiffInput({
        threadId: ThreadId.make("thread:checkpoint-contract"),
        scopeId: CheckpointScopeId.make("scope:checkpoint-contract"),
        checkpointId: CheckpointId.make("checkpoint:checkpoint-contract"),
        cursor: 0,
        limit: 100_000,
      }),
    ).toMatchObject({ cursor: 0, limit: 100_000 });
  });

  it("rejects result sizes above the advertised bounds", () => {
    expect(() => decodeListInput({ limit: 101 })).toThrow();
    expect(() =>
      decodeDiffInput({
        scopeId: "scope:checkpoint-contract",
        checkpointId: "checkpoint:checkpoint-contract",
        limit: 100_001,
      }),
    ).toThrow();
  });

  it("rejects malformed UTF-16 idempotency keys without normalizing valid keys", () => {
    const base = {
      scopeId: CheckpointScopeId.make("scope:checkpoint-contract"),
      checkpointId: CheckpointId.make("checkpoint:checkpoint-contract"),
      discardChanges: true,
    } as const;
    expect(() => decodeRestoreInput({ ...base, clientRequestId: "bad\ud800key" })).toThrow();
    expect(() => decodeRestoreInput({ ...base, clientRequestId: "bad\ud800" })).toThrow();
    expect(() => decodeRestoreInput({ ...base, clientRequestId: "bad\udc00key" })).toThrow();
    expect(
      decodeRestoreInput({ ...base, clientRequestId: "valid \ud83d\ude80" }).clientRequestId,
    ).toBe("valid \ud83d\ude80");
    expect(decodeRestoreInput({ ...base, clientRequestId: " e\u0301 " }).clientRequestId).toBe(
      " e\u0301 ",
    );
    expect(decodeRestoreInput({ ...base, clientRequestId: " é " }).clientRequestId).toBe(" é ");
  });
});

import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CheckpointMcpDiffInput,
  CheckpointMcpListInput,
  CheckpointScopeId,
  ThreadId,
} from "./index.ts";

const decodeListInput = Schema.decodeUnknownSync(CheckpointMcpListInput);
const decodeDiffInput = Schema.decodeUnknownSync(CheckpointMcpDiffInput);

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
});

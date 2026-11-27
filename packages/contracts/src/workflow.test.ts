import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { WorkflowRunsSubscribeInput, WorkflowRunsUpdate } from "./workflow.ts";

const decodeUpdate = Schema.decodeUnknownSync(WorkflowRunsUpdate);
const encodeInput = Schema.encodeSync(WorkflowRunsSubscribeInput);
// The input of a server from before `changes`.
const decodeOlderInput = Schema.decodeUnknownSync(Schema.Struct({}));

describe("workflows.subscribe across versions", () => {
  it("reads a whole list from a server that does not send changes", () => {
    const list = { workflows: [], runs: [], questions: [] };
    expect(decodeUpdate(list)).toEqual(list);
  });

  it("asks for changes in a way an older server ignores", () => {
    expect(() => decodeOlderInput(encodeInput({ changes: true }))).not.toThrow();
  });
});

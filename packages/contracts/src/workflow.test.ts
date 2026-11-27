import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  applyWorkflowRunsUpdate,
  WorkflowRunsSubscribeInput,
  WorkflowRunsUpdate,
} from "./workflow.ts";

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

  it("carries truncation flags across incremental change frames and preserves omitted ones", () => {
    const initial = applyWorkflowRunsUpdate(
      undefined,
      decodeUpdate({
        workflows: [],
        runs: [],
        questions: [],
        truncated: false,
        skippedTruncated: false,
      }),
    );
    expect([initial.truncated, initial.skippedTruncated]).toEqual([false, false]);

    const crossed = applyWorkflowRunsUpdate(
      initial,
      decodeUpdate({
        _tag: "changed",
        runs: [],
        removed: [],
        questions: [],
        closed: [],
        truncated: true,
      }),
    );
    expect([crossed.truncated, crossed.skippedTruncated]).toEqual([true, false]);

    const unchanged = applyWorkflowRunsUpdate(
      crossed,
      decodeUpdate({
        _tag: "changed",
        runs: [],
        removed: [],
        questions: [],
        closed: [],
      }),
    );
    expect([unchanged.truncated, unchanged.skippedTruncated]).toEqual([true, false]);
  });
});

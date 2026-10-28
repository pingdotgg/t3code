import { describe, expect, it } from "@effect/vitest";
import { PipelineUpsertInput, pipelineDefinitionIssues } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PIPELINE_STARTERS, withStarterRuntimeMode } from "./pipelineStarters.ts";

const encodeUpsert = Schema.encodeSync(PipelineUpsertInput);
const decodeUpsert = Schema.decodeUnknownSync(PipelineUpsertInput);

describe("PIPELINE_STARTERS", () => {
  it("has unique keys", () => {
    const keys = PIPELINE_STARTERS.map((starter) => starter.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(PIPELINE_STARTERS.map((starter) => [starter.key, starter] as const))(
    "%s is a valid pipeline definition",
    (_key, starter) => {
      const steps = withStarterRuntimeMode(starter.steps, "approval-required");
      const input = { name: starter.name, steps };
      expect(pipelineDefinitionIssues(steps)).toEqual([]);
      expect(() => decodeUpsert(encodeUpsert(input))).not.toThrow();
    },
  );
});

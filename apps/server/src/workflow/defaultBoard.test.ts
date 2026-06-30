import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WorkflowDefinition } from "@t3tools/contracts";
import { defaultBoardDefinition } from "./defaultBoard.ts";
import { encodeWorkflowDefinitionJson, lintWorkflowDefinition } from "./workflowFile.ts";

const decodeWorkflowDefinitionJson = Schema.decodeSync(Schema.fromJsonString(WorkflowDefinition));

describe("defaultBoardDefinition", () => {
  const def = defaultBoardDefinition({
    name: "My board",
    agent: { instance: "codex", model: "gpt-5.4" },
  });

  it("round-trips through the board file encoder", () => {
    const decoded = decodeWorkflowDefinitionJson(encodeWorkflowDefinitionJson(def));
    assert.equal(decoded.name, "My board");
    assert.deepEqual(
      decoded.lanes.map((lane) => lane.key as string),
      [
        "backlog",
        "planning",
        "specifying",
        "planning_issues",
        "implementation",
        "owner_review",
        "land",
        "manual_review",
        "implementation_issues",
        "done",
      ],
    );
  });

  it("passes the linter for a known agent instance", () => {
    const errors = lintWorkflowDefinition(def, {
      providerInstanceExists: (id) => id === "codex",
      instructionFileExists: () => true,
    });
    assert.deepEqual(errors, []);
  });

  it("bakes the agent into every agent step", () => {
    for (const lane of def.lanes) {
      for (const step of lane.pipeline ?? []) {
        if (step.type === "agent") {
          assert.equal(step.agent.instance, "codex");
          assert.equal(step.agent.model, "gpt-5.4");
        }
      }
    }
  });

  it("bounds the implementation review loop and escalates to manual review", () => {
    const implementation = def.lanes.find((lane) => (lane.key as string) === "implementation");
    assert.ok(implementation);
    const transitions = implementation.transitions ?? [];
    assert.equal(transitions.length, 3);
    assert.equal(transitions[0]?.to, "implementation");
    assert.equal(transitions[1]?.to, "manual_review");
    assert.equal(transitions[2]?.to, "owner_review");
    const loopRule = JSON.stringify(transitions[0]?.when);
    assert.ok(loopRule.includes("lane.runCount"));
    const review = implementation.pipeline?.find((step) => (step.key as string) === "review");
    assert.ok(review?.type === "agent" && review.captureOutput === true);
  });

  it("uses retry policies on the agent work steps and retention on done", () => {
    for (const stepKey of ["plan", "spec", "implement"]) {
      const step = def.lanes
        .flatMap((lane) => lane.pipeline ?? [])
        .find((candidate) => (candidate.key as string) === stepKey);
      assert.ok(
        step?.type === "agent" && step.retry?.maxAttempts === 2,
        `step ${stepKey} should retry`,
      );
    }
    const done = def.lanes.find((lane) => (lane.key as string) === "done");
    assert.ok(done?.terminal === true && done.retention !== undefined);
    const land = def.lanes.find((lane) => (lane.key as string) === "land");
    assert.equal(land?.pipeline?.[0]?.type, "merge");
  });
});

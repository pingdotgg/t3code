import { assert, describe, it } from "@effect/vitest";
import { emptyBoardDefinition } from "./emptyBoard.ts";
import { lintWorkflowDefinition } from "./workflowFile.ts";

describe("emptyBoardDefinition", () => {
  const def = emptyBoardDefinition({ name: "X" });

  it("produces a valid WorkflowDefinition (schema decode)", () => {
    assert.ok(def);
    assert.equal(def.name, "X");
  });

  it("has exactly 3 lanes with keys to-do, in-progress, done", () => {
    assert.equal(def.lanes.length, 3);
    assert.deepEqual(
      def.lanes.map((lane) => lane.key as string),
      ["to-do", "in-progress", "done"],
    );
  });

  it("all lanes have entry: manual", () => {
    for (const lane of def.lanes) {
      assert.equal(lane.entry, "manual");
    }
  });

  it("done lane has terminal === true", () => {
    const done = def.lanes.find((lane) => (lane.key as string) === "done");
    assert.ok(done);
    assert.equal(done.terminal, true);
  });

  it("no lane has a pipeline", () => {
    for (const lane of def.lanes) {
      assert.ok(lane.pipeline === undefined || lane.pipeline.length === 0);
    }
  });

  it("to-do has an action pointing to in-progress (no id field)", () => {
    const toDo = def.lanes.find((lane) => (lane.key as string) === "to-do");
    assert.ok(toDo);
    const actions = toDo.actions ?? [];
    assert.ok(actions.length > 0);
    const action = actions.find((a) => a.to === "in-progress");
    assert.ok(action, "expected an action with to === 'in-progress'");
    assert.ok("id" in action === false, "actions must not have an id field");
  });

  it("in-progress has an action pointing to done (no id field)", () => {
    const inProgress = def.lanes.find((lane) => (lane.key as string) === "in-progress");
    assert.ok(inProgress);
    const actions = inProgress.actions ?? [];
    assert.ok(actions.length > 0);
    const action = actions.find((a) => a.to === "done");
    assert.ok(action, "expected an action with to === 'done'");
    assert.ok("id" in action === false, "actions must not have an id field");
  });

  it("passes the linter with no errors", () => {
    const errors = lintWorkflowDefinition(def, {
      providerInstanceExists: () => true,
      instructionFileExists: () => true,
    });
    assert.deepEqual(errors, []);
  });
});

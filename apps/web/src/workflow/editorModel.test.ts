import {
  LaneKey,
  WorkflowDefinition,
  WorkflowDefinitionEncoded,
  type WorkflowDefinitionEncoded as WorkflowDefinitionEncodedType,
  type WorkflowLintError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  addLane,
  addLaneAction,
  addLaneEvent,
  addStep,
  addTransition,
  adjustSelectionAfterTransitionRemoval,
  canonicalizeDefinitionJson,
  createWorkflowEditorModel,
  discardWorkflowChanges,
  loadRevertedDefinition,
  markWorkflowSaved,
  normalizeSelection,
  removeLane,
  removeLaneAction,
  removeLaneEvent,
  removeStep,
  removeTransition,
  renameLane,
  reorderStep,
  setLaneColor,
  setLaneEntry,
  updateLaneAction,
  updateLaneEvent,
  setLaneOn,
  setLaneTerminal,
  setLaneWipLimit,
  setWorkflowLintErrors,
  updateStep,
  updateTransition,
  type WorkflowEditorSelection,
} from "./editorModel";

const decodeEditorDefinition = Schema.decodeUnknownEffect(WorkflowDefinitionEncoded);
const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);

const baseDefinition = {
  name: "Delivery",
  lanes: [
    { key: "queue", name: "Queue", entry: "manual" },
    {
      key: "run",
      name: "Run",
      entry: "auto",
      pipeline: [
        {
          key: "review",
          type: "agent",
          agent: { instance: "codex_main", model: "gpt-5.5" },
          instruction: "Review the diff.",
          captureOutput: true,
          on: { success: "done" },
        },
      ],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
} satisfies WorkflowDefinitionEncodedType;

const expectDecodable = (definition: WorkflowDefinitionEncodedType) =>
  Effect.gen(function* () {
    const encoded = yield* decodeEditorDefinition(definition);
    yield* decodeWorkflowDefinition(encoded);
  });

describe("workflow editor model", () => {
  it.effect("tracks dirty state, lint errors, saved baselines, and discards", () =>
    Effect.gen(function* () {
      const model = createWorkflowEditorModel(baseDefinition);
      expect(model.dirty).toBe(false);
      expect(model.lintErrors).toEqual([]);

      const renamed = renameLane(model, "queue", "Intake");
      expect(renamed).not.toBe(model);
      expect(renamed.definition.lanes[0]?.name).toBe("Intake");
      expect(model.definition.lanes[0]?.name).toBe("Queue");
      expect(renamed.dirty).toBe(true);

      const lintErrors = [
        { code: "invalid_wip_limit", message: "Bad WIP", laneKey: LaneKey.make("queue") },
      ] satisfies WorkflowLintError[];
      const withErrors = setWorkflowLintErrors(renamed, lintErrors);
      expect(withErrors.lintErrors).toEqual(lintErrors);

      const saved = markWorkflowSaved(withErrors, withErrors.definition);
      expect(saved.dirty).toBe(false);
      expect(saved.lintErrors).toEqual([]);
      expect(saved.baselineDefinition.lanes[0]?.name).toBe("Intake");

      const changedAgain = setLaneColor(saved, "queue", "#0ea5e9");
      const discarded = discardWorkflowChanges(changedAgain);
      expect(discarded.dirty).toBe(false);
      expect(discarded.definition).toEqual(saved.baselineDefinition);
      yield* expectDecodable(discarded.definition);
    }),
  );

  it("loads reverted definitions as dirty changes without adopting the old version as baseline", () => {
    const model = createWorkflowEditorModel(baseDefinition);
    const oldVersionDefinition = {
      name: "Delivery v1",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    } satisfies WorkflowDefinitionEncodedType;

    const reverted = loadRevertedDefinition(model, oldVersionDefinition);

    expect(reverted.definition).toEqual(oldVersionDefinition);
    expect(reverted.definition).not.toBe(oldVersionDefinition);
    expect(reverted.baselineDefinition).toEqual(model.baselineDefinition);
    expect(reverted.dirty).toBe(true);
    expect(reverted.lintErrors).toEqual([]);
    expect(reverted.pendingSaveSource).toBe("revert");

    const discarded = discardWorkflowChanges(reverted);
    expect(discarded.definition).toEqual(model.baselineDefinition);
    expect(discarded.pendingSaveSource).toBeUndefined();

    const saved = markWorkflowSaved(reverted, oldVersionDefinition);
    expect(saved.pendingSaveSource).toBeUndefined();
  });

  it("canonicalizes encoded workflow definitions with stable key order", () => {
    const left = {
      lanes: [
        {
          name: "Run",
          pipeline: [{ run: "pnpm test", type: "script", timeout: "5 minutes", key: "smoke" }],
          entry: "auto",
          key: "run",
        },
        { terminal: true, entry: "manual", name: "Done", key: "done" },
      ],
      name: "Canonical",
    } satisfies WorkflowDefinitionEncodedType;
    const right = {
      name: "Canonical",
      lanes: [
        {
          key: "run",
          entry: "auto",
          pipeline: [{ key: "smoke", timeout: "5 minutes", type: "script", run: "pnpm test" }],
          name: "Run",
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    } satisfies WorkflowDefinitionEncodedType;

    const canonical = canonicalizeDefinitionJson(left);

    expect(canonical).toBe(canonicalizeDefinitionJson(right));
    expect(canonical.split("\n").slice(0, 3)).toEqual(["{", '  "lanes": [', "    {"]);
  });

  it.effect("mutates lanes immutably with unique keys and decodable encoded output", () =>
    Effect.gen(function* () {
      let model = createWorkflowEditorModel(baseDefinition);
      model = addLane(model);
      model = addLane(model);
      const addedKeys = model.definition.lanes.slice(-2).map((lane) => lane.key);
      expect(addedKeys).toEqual(["new-lane", "new-lane-2"]);

      model = renameLane(model, "new-lane", "QA");
      model = setLaneEntry(model, "new-lane", "auto");
      model = setLaneWipLimit(model, "new-lane", 3);
      model = setLaneTerminal(model, "new-lane", false);
      model = setLaneColor(model, "new-lane", "#22c55e");

      const lane = model.definition.lanes.find((candidate) => candidate.key === "new-lane");
      expect(lane).toEqual({
        key: "new-lane",
        name: "QA",
        entry: "auto",
        wipLimit: 3,
        terminal: false,
        color: "#22c55e",
      });

      model = setLaneWipLimit(model, "new-lane", undefined);
      model = setLaneColor(model, "new-lane", undefined);
      model = removeLane(model, "new-lane-2");
      expect(model.definition.lanes.some((candidate) => candidate.key === "new-lane-2")).toBe(
        false,
      );
      yield* expectDecodable(model.definition);
    }),
  );

  it.effect("adds, updates, reorders, and removes steps with decodable defaults", () =>
    Effect.gen(function* () {
      let model = createWorkflowEditorModel(baseDefinition);
      model = addStep(model, "queue", "agent");
      model = addStep(model, "queue", "script");
      model = addStep(model, "queue", "approval");

      const steps = model.definition.lanes[0]?.pipeline ?? [];
      expect(steps.map((step) => step.key)).toEqual(["agent", "script", "approval"]);
      const agent = steps[0];
      expect(agent?.type).toBe("agent");
      if (agent?.type === "agent") {
        expect(agent.agent).toEqual({ instance: "codex_main", model: "gpt-5.5" });
        expect(agent.instruction).toBe("");
      }
      const script = steps[1];
      expect(script?.type).toBe("script");
      if (script?.type === "script") {
        expect(script.run).toBe("true");
      }

      model = updateStep(model, "queue", "script", {
        run: "pnpm test",
        timeout: "5 minutes",
        on: { failure: "run" },
      });
      const updatedScript = model.definition.lanes[0]?.pipeline?.find(
        (step) => step.key === "script",
      );
      expect(updatedScript?.type).toBe("script");
      if (updatedScript?.type === "script") {
        expect(updatedScript.timeout).toBe("5 minutes");
        expect(updatedScript.on?.failure).toBe("run");
      }

      model = reorderStep(model, "queue", 2, 0);
      expect(model.definition.lanes[0]?.pipeline?.map((step) => step.key)).toEqual([
        "approval",
        "agent",
        "script",
      ]);
      model = removeStep(model, "queue", "agent");
      expect(model.definition.lanes[0]?.pipeline?.map((step) => step.key)).toEqual([
        "approval",
        "script",
      ]);
      yield* expectDecodable(model.definition);
    }),
  );

  it.effect("mutates lane routing and transitions with parsed transition predicates", () =>
    Effect.gen(function* () {
      let model = createWorkflowEditorModel(baseDefinition);
      model = setLaneOn(model, "queue", "success", "run");
      model = setLaneOn(model, "queue", "failure", "done");
      model = setLaneOn(model, "queue", "failure", undefined);
      expect(model.definition.lanes[0]?.on).toEqual({ success: "run" });

      model = addTransition(model, "run");
      model = updateTransition(model, "run", 0, {
        when: { "==": [{ var: "steps.review.output.verdict" }, "pass"] },
        to: "done",
      });
      expect(model.definition.lanes[1]?.transitions?.[0]).toEqual({
        when: { "==": [{ var: "steps.review.output.verdict" }, "pass"] },
        to: "done",
      });

      model = removeTransition(model, "run", 0);
      expect(model.definition.lanes[1]?.transitions).toBeUndefined();
      yield* expectDecodable(model.definition);
    }),
  );

  it.effect("mutates lane external-event matchers", () =>
    Effect.gen(function* () {
      let model = createWorkflowEditorModel(baseDefinition);
      model = addLaneEvent(model, "run");
      expect(model.definition.lanes[1]?.onEvent?.[0]?.name).toBe("ci.passed");

      model = updateLaneEvent(model, "run", 0, {
        name: "ci.finished",
        when: { "==": [{ var: "event.payload.status" }, "green"] },
        to: "done",
      });
      expect(model.definition.lanes[1]?.onEvent?.[0]).toEqual({
        name: "ci.finished",
        when: { "==": [{ var: "event.payload.status" }, "green"] },
        to: "done",
      });

      // when: null clears the predicate, undefined keeps it.
      model = updateLaneEvent(model, "run", 0, { when: null });
      expect(model.definition.lanes[1]?.onEvent?.[0]).toEqual({ name: "ci.finished", to: "done" });
      yield* expectDecodable(model.definition);

      model = removeLaneEvent(model, "run", 0);
      expect(model.definition.lanes[1]?.onEvent).toBeUndefined();
      yield* expectDecodable(model.definition);
    }),
  );

  it.effect("drops lane action and event targets referencing a removed lane", () =>
    Effect.gen(function* () {
      let model = createWorkflowEditorModel(baseDefinition);
      model = addLaneAction(model, "queue");
      model = updateLaneAction(model, "queue", 0, { to: "run" });
      model = addLaneAction(model, "queue");
      model = updateLaneAction(model, "queue", 1, { to: "done" });
      model = addLaneEvent(model, "queue");
      model = updateLaneEvent(model, "queue", 0, { to: "run" });
      model = addLaneEvent(model, "queue");
      model = updateLaneEvent(model, "queue", 1, { to: "done" });

      model = removeLane(model, "run");

      expect(model.definition.lanes[0]?.actions).toEqual([{ label: "New action", to: "done" }]);
      expect(model.definition.lanes[0]?.onEvent).toEqual([{ name: "ci.passed", to: "done" }]);

      model = removeLane(model, "done");
      expect(model.definition.lanes[0]?.actions).toBeUndefined();
      expect(model.definition.lanes[0]?.onEvent).toBeUndefined();
      yield* expectDecodable(model.definition);
    }),
  );

  it("does not throw when transition patches contain invalid JSON text", () => {
    let model = createWorkflowEditorModel(baseDefinition);
    model = addTransition(model, "run");

    expect(() =>
      updateTransition(model, "run", 0, {
        when: "{",
      }),
    ).not.toThrow();
  });

  it("normalizes stale lane, step, and transition selections after model mutations", () => {
    let model = createWorkflowEditorModel(baseDefinition);
    model = addTransition(model, "run");

    const laneSelection = {
      kind: "lane",
      laneKey: "run",
    } satisfies WorkflowEditorSelection;
    const stepSelection = {
      kind: "step",
      laneKey: "run",
      stepKey: "review",
    } satisfies WorkflowEditorSelection;
    const transitionSelection = {
      kind: "transition",
      laneKey: "run",
      index: 0,
    } satisfies WorkflowEditorSelection;

    expect(normalizeSelection(model, laneSelection)).toEqual(laneSelection);
    expect(normalizeSelection(model, stepSelection)).toEqual(stepSelection);
    expect(normalizeSelection(model, transitionSelection)).toEqual(transitionSelection);

    const withoutStep = removeStep(model, "run", "review");
    expect(normalizeSelection(withoutStep, stepSelection)).toEqual({
      kind: "lane",
      laneKey: "run",
    });

    const withoutTransition = removeTransition(model, "run", 0);
    expect(normalizeSelection(withoutTransition, transitionSelection)).toEqual({
      kind: "lane",
      laneKey: "run",
    });

    const withoutLane = removeLane(model, "run");
    expect(normalizeSelection(withoutLane, laneSelection)).toBeNull();
  });

  it("adjusts transition selections from the removed index before normalizing", () => {
    const selectedTransition = {
      kind: "transition",
      laneKey: "run",
      index: 1,
    } satisfies WorkflowEditorSelection;

    expect(adjustSelectionAfterTransitionRemoval(selectedTransition, "run", 0)).toEqual({
      kind: "transition",
      laneKey: "run",
      index: 0,
    });
    expect(adjustSelectionAfterTransitionRemoval(selectedTransition, "run", 1)).toEqual({
      kind: "lane",
      laneKey: "run",
    });
    expect(adjustSelectionAfterTransitionRemoval(selectedTransition, "run", 2)).toEqual(
      selectedTransition,
    );
    expect(adjustSelectionAfterTransitionRemoval(selectedTransition, "queue", 0)).toEqual(
      selectedTransition,
    );
  });

  it("falls back to the lane when the selected transition is removed from a multi-transition lane", () => {
    const model = createWorkflowEditorModel({
      ...baseDefinition,
      lanes: baseDefinition.lanes.map((lane) =>
        lane.key === "run"
          ? {
              ...lane,
              transitions: [
                { when: { "==": [{ var: "ticket.status" }, "queued"] }, to: "queue" },
                { when: { "==": [{ var: "ticket.status" }, "done"] }, to: "done" },
                { when: { "==": [{ var: "ticket.status" }, "retry"] }, to: "queue" },
              ],
            }
          : lane,
      ),
    });
    const selection = {
      kind: "transition",
      laneKey: "run",
      index: 1,
    } as const;

    const withoutSelectedTransition = removeTransition(model, "run", 1);
    const adjustedSelection = adjustSelectionAfterTransitionRemoval(selection, "run", 1);

    expect(normalizeSelection(withoutSelectedTransition, adjustedSelection)).toEqual({
      kind: "lane",
      laneKey: "run",
    });
  });

  it("keeps the same selected transition when an earlier transition is removed", () => {
    const model = createWorkflowEditorModel({
      ...baseDefinition,
      lanes: baseDefinition.lanes.map((lane) =>
        lane.key === "run"
          ? {
              ...lane,
              transitions: [
                { when: { "==": [{ var: "ticket.status" }, "queued"] }, to: "queue" },
                { when: { "==": [{ var: "ticket.status" }, "done"] }, to: "done" },
                { when: { "==": [{ var: "ticket.status" }, "retry"] }, to: "queue" },
              ],
            }
          : lane,
      ),
    });
    const selection = {
      kind: "transition",
      laneKey: "run",
      index: 1,
    } as const;

    const withoutEarlierTransition = removeTransition(model, "run", 0);
    const adjustedSelection = adjustSelectionAfterTransitionRemoval(selection, "run", 0);

    expect(normalizeSelection(withoutEarlierTransition, adjustedSelection)).toEqual({
      kind: "transition",
      laneKey: "run",
      index: 0,
    });
  });
});

describe("lane actions", () => {
  const base = {
    name: "Action board",
    lanes: [
      { key: "review", name: "Review", entry: "manual" },
      { key: "land", name: "Land", entry: "manual" },
    ],
  } as never;

  it("adds, edits, and removes lane actions", () => {
    let model = createWorkflowEditorModel(base);
    model = addLaneAction(model, "review");
    expect(model.definition.lanes[0]?.actions).toEqual([{ label: "New action", to: "land" }]);

    model = updateLaneAction(model, "review", 0, {
      label: "Approve & land" as never,
      hint: "Merge it.",
    });
    expect(model.definition.lanes[0]?.actions?.[0]).toEqual({
      label: "Approve & land",
      to: "land",
      hint: "Merge it.",
    });

    model = updateLaneAction(model, "review", 0, { hint: "" });
    expect(model.definition.lanes[0]?.actions?.[0]).toEqual({
      label: "Approve & land",
      to: "land",
    });

    model = removeLaneAction(model, "review", 0);
    expect(model.definition.lanes[0]?.actions).toBeUndefined();
    expect(model.dirty).toBe(true);
  });

  it("updateLaneAction is a no-op on out-of-range index", () => {
    let model = createWorkflowEditorModel(base);
    // No actions yet — out-of-range index leaves lane.actions undefined
    model = updateLaneAction(model, "review", 0, { to: "land" });
    expect(model.definition.lanes[0]?.actions).toBeUndefined();

    // With one action — negative and high index leave it unchanged
    model = addLaneAction(model, "review");
    const snapshot = model.definition.lanes[0]?.actions;
    model = updateLaneAction(model, "review", -1, { to: "land" });
    expect(model.definition.lanes[0]?.actions).toEqual(snapshot);
    model = updateLaneAction(model, "review", 5, { to: "land" });
    expect(model.definition.lanes[0]?.actions).toEqual(snapshot);
  });
});

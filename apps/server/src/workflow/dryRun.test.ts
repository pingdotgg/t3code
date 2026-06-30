import type { WorkflowDefinition } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PredicateEvaluatorLive } from "./Layers/PredicateEvaluator.ts";
import { PredicateEvaluator } from "./Services/PredicateEvaluator.ts";
import { simulateBoardRoute } from "./dryRun.ts";

const definition = {
  name: "Dry run",
  lanes: [
    { key: "backlog", name: "Backlog", entry: "manual" },
    {
      key: "work",
      name: "Work",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
          on: { success: "review", blocked: "stuck" },
        },
      ],
      on: { failure: "stuck" },
    },
    {
      key: "review",
      name: "Review",
      entry: "auto",
      pipeline: [
        {
          key: "check",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "review it",
        },
      ],
      // Self-loop twice (streak grows while runs stay in this lane), then
      // fall through to done.
      transitions: [{ when: { "<": [{ var: "lane.runCount" }, 3] }, to: "review" }],
      on: { success: "done" },
    },
    { key: "stuck", name: "Stuck", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
} as unknown as WorkflowDefinition;

const layer = it.layer(PredicateEvaluatorLive);

layer("simulateBoardRoute", (it) => {
  it.effect("walks step routes and bounded self-loop transitions to the terminal lane", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const run = yield* simulateBoardRoute({
        definition,
        startLane: "work" as never,
        scenario: "success",
        evaluator,
      });

      // work →(step.on) review →(self-loop ×2 while runCount < 3) →(lane.on) done
      assert.equal(run.end, "terminal");
      assert.equal(run.endLane, "done");
      assert.deepEqual(
        run.hops.map((hop) => `${hop.fromLane}>${hop.toLane}:${hop.source}`),
        [
          "work>review:step_on",
          "review>review:lane_transition",
          "review>review:lane_transition",
          "review>done:lane_on",
        ],
      );
      assert.equal(run.hops[0]?.viaStepKey, "code");
      assert.equal(run.hops[1]?.matchedTransitionIndex, 0);
      assert.lengthOf(run.notes, 0);
    }),
  );

  it.effect("lane.runCount resets when another lane runs, exactly like the engine", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      // Review bounces back to work, so review's streak never exceeds 1 and
      // `runCount < 3` matches forever — the live engine loops unboundedly,
      // and the dry run must say so instead of claiming a bounded loop.
      const alternating = {
        ...definition,
        lanes: (definition.lanes as ReadonlyArray<Record<string, unknown>>).map((lane) =>
          lane["key"] === "review"
            ? {
                ...lane,
                transitions: [{ when: { "<": [{ var: "lane.runCount" }, 3] }, to: "work" }],
              }
            : lane,
        ),
      } as unknown as WorkflowDefinition;
      const run = yield* simulateBoardRoute({
        definition: alternating,
        startLane: "work" as never,
        scenario: "success",
        evaluator,
      });
      assert.equal(run.end, "cycle_cap");
      assert.equal(run.hops.length, 25);
    }),
  );

  it.effect("failure scenario falls through lane.on into a manual lane", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const run = yield* simulateBoardRoute({
        definition,
        startLane: "work" as never,
        scenario: "failure",
        evaluator,
      });
      assert.equal(run.end, "manual");
      assert.equal(run.endLane, "stuck");
      assert.deepEqual(
        run.hops.map((hop) => `${hop.fromLane}>${hop.toLane}:${hop.source}`),
        ["work>stuck:lane_on"],
      );
    }),
  );

  it.effect("blocked scenario uses the step's blocked route", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const run = yield* simulateBoardRoute({
        definition,
        startLane: "work" as never,
        scenario: "blocked",
        evaluator,
      });
      assert.equal(run.hops[0]?.toLane, "stuck");
      assert.equal(run.hops[0]?.source, "step_on");
      assert.equal(run.end, "manual");
    }),
  );

  it.effect("a manual start lane without a pipeline ends immediately", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const run = yield* simulateBoardRoute({
        definition,
        startLane: "backlog" as never,
        scenario: "success",
        evaluator,
      });
      assert.equal(run.end, "manual");
      assert.equal(run.endLane, "backlog");
      assert.lengthOf(run.hops, 0);
    }),
  );

  it.effect("an empty auto lane never routes, exactly like the engine", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      // The engine returns before starting a pipeline when there are no
      // steps, so the lane.on fallback must NOT fire in the dry run either.
      const noSteps = {
        name: "No steps",
        lanes: [
          { key: "only", name: "Only", entry: "auto", pipeline: [], on: { success: "done" } },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      } as unknown as WorkflowDefinition;
      const run = yield* simulateBoardRoute({
        definition: noSteps,
        startLane: "only" as never,
        scenario: "success",
        evaluator,
      });
      assert.equal(run.end, "no_route");
      assert.equal(run.endLane, "only");
      assert.isTrue(run.notes.some((note) => note.includes("has no steps")));
    }),
  );

  it.effect("an unbounded loop stops at the hop cap", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const step = (key: string) => ({ key, type: "script", run: "true" });
      const looping = {
        name: "Loop",
        lanes: [
          { key: "a", name: "A", entry: "auto", pipeline: [step("sa")], on: { success: "b" } },
          { key: "b", name: "B", entry: "auto", pipeline: [step("sb")], on: { success: "a" } },
        ],
      } as unknown as WorkflowDefinition;
      const run = yield* simulateBoardRoute({
        definition: looping,
        startLane: "a" as never,
        scenario: "success",
        evaluator,
      });
      assert.equal(run.end, "cycle_cap");
      assert.equal(run.hops.length, 25);
    }),
  );

  it.effect("notes when predicates read the approximated ticket status", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const statusBoard = {
        name: "Status",
        lanes: [
          {
            key: "work",
            name: "Work",
            entry: "auto",
            pipeline: [{ key: "s", type: "script", run: "true" }],
            transitions: [{ when: { "==": [{ var: "status" }, "running"] }, to: "done" }],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      } as unknown as WorkflowDefinition;
      const run = yield* simulateBoardRoute({
        definition: statusBoard,
        startLane: "work" as never,
        scenario: "success",
        evaluator,
      });
      assert.equal(run.end, "terminal");
      assert.isTrue(run.notes.some((note) => note.includes("approximates it")));
    }),
  );

  it.effect("does not strand a lane whose only exit gates on captured step output", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const outputBoard = {
        name: "Output gated",
        lanes: [
          {
            key: "review",
            name: "Review",
            entry: "auto",
            pipeline: [
              {
                key: "review",
                type: "agent",
                agent: { instance: "claude_main", model: "sonnet" },
                instruction: "review",
                captureOutput: true,
              },
            ],
            // The ONLY way out is an output-conditioned transition: a dry run
            // reads `steps.review.output.verdict` as null, so without the fix
            // this lane falsely reports as a dead end (no_route).
            transitions: [
              {
                when: { "==": [{ var: "steps.review.output.verdict" }, "approve"] },
                to: "done",
              },
            ],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      } as unknown as WorkflowDefinition;
      const run = yield* simulateBoardRoute({
        definition: outputBoard,
        startLane: "review" as never,
        scenario: "success",
        evaluator,
      });
      assert.notEqual(run.end, "no_route");
      assert.equal(run.endLane, "done");
      assert.isTrue(run.notes.some((note) => note.includes("captured step output")));
    }),
  );
});

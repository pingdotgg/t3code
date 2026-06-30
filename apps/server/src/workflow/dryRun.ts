import type {
  LaneKey,
  WorkflowDefinition,
  WorkflowDryRunHop,
  WorkflowDryRunResult,
  WorkflowDryRunScenario,
  WorkflowLane,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { inspectJsonLogicRule } from "./jsonLogicRule.ts";
import type { PredicateEvaluatorShape } from "./Services/PredicateEvaluator.ts";

/**
 * Simulates a hypothetical ticket's path through a board definition without
 * touching any real state. Every agent/script/approval step is assumed to end
 * with the chosen scenario outcome; routing then follows the engine's real
 * precedence (step.on → lane transitions → lane.on). Transition predicates are
 * evaluated against a synthetic context that mirrors the engine's:
 * `lane.runCount` is the consecutive streak of pipeline runs in the lane
 * (reset by a run elsewhere, exactly like `countLanePipelineRuns`), and data a
 * dry run cannot know (captured outputs, ticket fields) reads as null — the
 * same as missing data in the engine.
 */

const MAX_HOPS = 25;

export type DryRunPredicateEvaluator = Pick<PredicateEvaluatorShape, "evaluate">;

const stepStatusForResult = (result: WorkflowDryRunScenario): string =>
  result === "success" ? "completed" : result === "failure" ? "failed" : "blocked";

// What the routing-context builder would read from the projection at decision
// time: tickets run as "running"; step failures and blocks project the ticket
// as "blocked" before the route is decided.
const ticketStatusForResult = (result: WorkflowDryRunScenario): string =>
  result === "success" ? "running" : "blocked";

export const simulateBoardRoute = ({
  definition,
  startLane,
  scenario,
  evaluator,
}: {
  readonly definition: WorkflowDefinition;
  readonly startLane: LaneKey;
  readonly scenario: WorkflowDryRunScenario;
  readonly evaluator: DryRunPredicateEvaluator;
}): Effect.Effect<WorkflowDryRunResult, never> =>
  Effect.gen(function* () {
    const laneByKey = new Map<string, WorkflowLane>(
      definition.lanes.map((lane) => [lane.key as string, lane]),
    );
    const hops: Array<WorkflowDryRunHop> = [];
    const notes: Array<string> = [];
    const pushNote = (note: string) => {
      if (!notes.includes(note)) {
        notes.push(note);
      }
    };
    const finish = (end: WorkflowDryRunResult["end"], endLane: LaneKey): WorkflowDryRunResult => ({
      startLane,
      scenario,
      hops,
      end,
      endLane,
      notes,
    });

    // Mirrors countLanePipelineRuns: the streak only grows while consecutive
    // pipeline runs stay in the same lane; a run elsewhere resets it.
    let streakLane: string | null = null;
    let streakCount = 0;

    let currentKey = startLane;
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
      const lane = laneByKey.get(currentKey as string);
      if (lane === undefined) {
        pushNote(`Lane "${currentKey as string}" does not exist — the walk cannot continue.`);
        return finish("no_route", currentKey);
      }
      if (lane.terminal === true) {
        return finish("terminal", currentKey);
      }
      const isStart = hops.length === 0;
      // A manual lane parks the ticket until a human acts. The start lane is
      // the exception: simulate it as if the user pressed "Run lane".
      if (lane.entry !== "auto" && !isStart) {
        return finish("manual", currentKey);
      }
      const steps = lane.pipeline ?? [];
      if (steps.length === 0) {
        if (lane.entry !== "auto") {
          return finish("manual", currentKey);
        }
        // The engine returns before starting a pipeline for a lane with no
        // steps, so transitions and fallbacks are never evaluated.
        pushNote(
          `Auto lane "${currentKey as string}" has no steps — its pipeline never runs, so nothing routes out of it.`,
        );
        return finish("no_route", currentKey);
      }
      if (hop === MAX_HOPS) {
        return finish("cycle_cap", currentKey);
      }

      streakCount = streakLane === (currentKey as string) ? streakCount + 1 : 1;
      streakLane = currentKey as string;

      // Mirror of the engine's pipeline walk: each step ends with the
      // scenario outcome; a step.on match (or a non-success) stops the run.
      const stepsContext: Record<string, unknown> = {};
      let result: WorkflowDryRunScenario = "success";
      let decision: WorkflowDryRunHop | null = null;
      for (const step of steps) {
        result = scenario;
        stepsContext[step.key as string] = {
          exitCode: result === "success" ? 0 : 1,
          status: stepStatusForResult(result),
          output: null,
        };
        const target = step.on?.[result];
        if (target !== undefined) {
          decision = {
            fromLane: currentKey,
            toLane: target,
            source: "step_on",
            viaStepKey: step.key,
            result,
          };
          break;
        }
        if (result !== "success") {
          break;
        }
      }

      if (decision === null) {
        const status = ticketStatusForResult(result);
        const context = {
          pipeline: { result },
          lane: { runCount: streakCount },
          status,
          steps: stepsContext,
        };
        // A dry run models every captured step output as null, so a transition
        // that gates ONLY on `steps.<key>.output.*` can never match here even
        // though it would route live. Track the first such transition so a lane
        // whose only way out is output-conditioned is reported as an
        // (indeterminate) route rather than a false "strands tickets" dead end.
        let outputGatedFallback: {
          readonly toLane: LaneKey;
          readonly index: number;
        } | null = null;
        for (const [index, transition] of (lane.transitions ?? []).entries()) {
          const paths = inspectJsonLogicRule(transition.when).variablePaths;
          if (paths.includes("status")) {
            pushNote(
              `Transition predicates read the ticket status — the dry run approximates it as "${status}".`,
            );
          }
          const isOutputPath = (path: string) => /^steps\.[^.]+\.output(\.|$)/.test(path);
          // Only treat a transition as "indeterminate because captured output is
          // unavailable" when EVERY variable it reads is captured output. A mixed
          // predicate that also reads a deterministic input (e.g. `status`) and
          // fails on that part is a REAL non-match, not a dry-run blind spot — so
          // it must not be optimistically followed.
          const onlyOutputGated = paths.length > 0 && paths.every(isOutputPath);
          const evaluation = yield* evaluator
            .evaluate(transition.when, context)
            .pipe(Effect.orElseSucceed(() => null));
          if (evaluation === null) {
            // The engine fails the whole routing path on a predicate error;
            // there is nothing meaningful to simulate past this point. A
            // transition gated on captured output evaluates against null here,
            // which is a known dry-run blind spot rather than a real predicate
            // error — skip it so it doesn't masquerade as a routing fault.
            if (onlyOutputGated) {
              if (outputGatedFallback === null) {
                outputGatedFallback = { toLane: transition.to, index };
              }
              continue;
            }
            pushNote(
              `Lane "${currentKey as string}" transition #${index + 1} predicate failed to evaluate — live routing would error here.`,
            );
            return finish("no_route", currentKey);
          }
          if (evaluation.result) {
            decision = {
              fromLane: currentKey,
              toLane: transition.to,
              source: "lane_transition",
              matchedTransitionIndex: index,
              result,
            };
            break;
          }
          // Didn't match — but if it could only match on captured output the
          // dry run cannot know, remember it as a possible exit.
          if (onlyOutputGated && outputGatedFallback === null) {
            outputGatedFallback = { toLane: transition.to, index };
          }
        }

        // No concrete transition matched and no lane.on fallback will be tried
        // below: rather than mislabel an output-only routed lane as a dead end,
        // optimistically follow the first output-gated transition and flag it.
        if (decision === null && outputGatedFallback !== null && lane.on?.[result] === undefined) {
          pushNote(
            `Lane "${currentKey as string}" routes out only via captured step output the dry run cannot evaluate — assuming transition #${outputGatedFallback.index + 1} can match.`,
          );
          decision = {
            fromLane: currentKey,
            toLane: outputGatedFallback.toLane,
            source: "lane_transition",
            matchedTransitionIndex: outputGatedFallback.index,
            result,
          };
        }
      }

      if (decision === null) {
        const target = lane.on?.[result];
        if (target !== undefined) {
          decision = { fromLane: currentKey, toLane: target, source: "lane_on", result };
        }
      }

      if (decision === null) {
        return finish("no_route", currentKey);
      }
      hops.push(decision);
      currentKey = decision.toLane;
    }
    return finish("cycle_cap", currentKey);
  });

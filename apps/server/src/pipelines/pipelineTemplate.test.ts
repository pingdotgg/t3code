import { assert, describe, it } from "@effect/vitest";
import type { PipelineRunStepStatus, PipelineSnapshot, PipelineStep } from "@t3tools/contracts";

import {
  pipelineReferencedStepIndexes,
  pipelineUpstreamChangedMessage,
  renderPipelinePrompt,
} from "./pipelineTemplate.ts";

function step(id: string, name: string, promptTemplate: string, skills: string[] = []) {
  return { id, name, promptTemplate, skills } as unknown as PipelineStep;
}

const state = (status: PipelineRunStepStatus, output: string | null = null) => ({
  status,
  output,
});

const snapshot = (...steps: PipelineStep[]) => ({ name: "Pipeline", steps }) as PipelineSnapshot;

const plan = step("plan", "Plan", "plan {{input}}");
const build = step("build", "Build Feature", "build");
const review = (template: string, skills?: string[]) => step("review", "Review", template, skills);

describe("renderPipelinePrompt", () => {
  it.each([
    {
      name: "input",
      steps: [review("Do: {{input}}!")],
      state: [state("pending")],
      expected: "Do: ship it!",
    },
    {
      name: "previous skips a skipped step to the nearest earlier completed one",
      steps: [plan, build, review("{{previous.output}}")],
      state: [state("completed", "plan out"), state("skipped"), state("pending")],
      index: 2,
      expected: "plan out",
    },
    {
      name: "previous is empty without an earlier completed step",
      steps: [plan, review("[{{previous.output}}]")],
      state: [state("failed", "partial"), state("pending")],
      index: 1,
      expected: "[]",
    },
    {
      name: "steps by id",
      steps: [plan, build, review("{{steps.plan.output}}")],
      state: [state("completed", "plan out"), state("completed", "build out"), state("pending")],
      index: 2,
      expected: "plan out",
    },
    {
      name: "steps by name, case-insensitive",
      steps: [plan, build, review("{{steps.BUILD feature.output}}")],
      state: [state("completed", "plan out"), state("completed", "build out"), state("pending")],
      index: 2,
      expected: "build out",
    },
    {
      name: "skipped and not-completed steps render empty",
      steps: [plan, build, review("<{{steps.plan.output}}|{{steps.build.output}}>")],
      state: [state("skipped", "ignored"), state("failed", "ignored"), state("pending")],
      index: 2,
      expected: "<|>",
    },
    {
      name: "whitespace inside braces",
      steps: [plan, review("{{  input  }} {{ steps.plan.output }} {{ previous.output }}")],
      state: [state("completed", "p"), state("pending")],
      index: 1,
      expected: "ship it p p",
    },
    {
      name: "unknown expressions are left as-is",
      steps: [review("{{nope}} {{steps.missing.output}} {{input}}")],
      state: [state("pending")],
      expected: "{{nope}} {{steps.missing.output}} ship it",
    },
    {
      name: "skills line precedes the template",
      steps: [review("body {{input}}", ["a", "b"])],
      state: [state("pending")],
      expected: "$a $b\n\nbody ship it",
    },
    {
      name: "outputs are not re-expanded",
      steps: [plan, review("{{previous.output}} / {{input}}")],
      state: [state("completed", "echo {{input}} {{previous.output}}"), state("pending")],
      index: 1,
      expected: "echo {{input}} {{previous.output}} / ship it",
    },
  ])("$name", (testCase) => {
    const index = testCase.index ?? 0;
    const result = renderPipelinePrompt({
      snapshot: snapshot(...testCase.steps),
      stepIndex: index,
      input: "ship it",
      steps: testCase.state,
    });
    assert.strictEqual(result.prompt, testCase.expected);
  });
});

describe("revision messages", () => {
  it("finds only the outputs a step's template reads", () => {
    const qa = step("qa", "QA", "{{previous.output}} and {{steps.plan.output}}");
    const names = snapshot(plan, build, qa);
    assert.deepStrictEqual(
      pipelineReferencedStepIndexes(names, 2, (index) => index !== 1),
      [0],
    );
    assert.deepStrictEqual(
      pipelineReferencedStepIndexes(names, 2, () => true),
      [0, 1],
    );
    assert.deepStrictEqual(
      pipelineReferencedStepIndexes(snapshot(plan, build), 1, () => true),
      [],
    );
  });

  it("lists every revision oldest first with quotes in an upstream-changed message", () => {
    const history = [
      { stepIndex: 0, feedback: "first note", quote: "old text", author: "user" as const },
      { stepIndex: 1, feedback: "second note", quote: null, author: "coordinator" as const },
    ];
    const text = pipelineUpstreamChangedMessage({
      revised: history[1]!,
      history,
      stepNames: ["Plan", "Build"],
      outputs: [{ stepIndex: 1, output: "new build" }],
      handoff: "HANDOFF",
    });
    assert.include(text, "new build");
    const listing = text.slice(text.indexOf("All feedback"));
    assert.isTrue(listing.indexOf("first note") < listing.indexOf("second note"));
    assert.include(text, "> old text");
    assert.isTrue(text.endsWith("HANDOFF"));
  });
});

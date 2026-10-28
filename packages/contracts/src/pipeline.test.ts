import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PIPELINE_MAX_STEPS,
  PipelineDefinition,
  PipelineUpsertInput,
  pipelineDefinitionIssues,
  pipelineTemplateReferences,
  resolvePipelineStepKey,
} from "./pipeline.ts";

const step = (id: string, promptTemplate: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Step ${id}`,
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  skills: [],
  promptTemplate,
  pauseBefore: false,
  ...overrides,
});

const upsert = (steps: ReadonlyArray<unknown>) => ({ name: "Review", steps });
const decodeUpsert = Schema.decodeUnknownSync(PipelineUpsertInput);
const decodeDefinition = Schema.decodeUnknownSync(PipelineDefinition);

describe("PipelineUpsertInput", () => {
  it("accepts a chain that reads input, the previous step, and earlier steps by id or name", () => {
    const input = upsert([
      step("plan", "{{input}}", { skills: ["review", "my:skill_2"] }),
      step("build", "{{ previous.output }}"),
      step("check", "{{steps.plan.output}} and {{steps.STEP build.output}}"),
    ]);
    expect(decodeUpsert(input).steps.map((s) => s.id)).toEqual(["plan", "build", "check"]);
  });

  it("ignores the removed per-step interactionMode on rows stored before it was dropped", () => {
    const decoded = decodeUpsert(upsert([step("a", "x", { interactionMode: "plan" })]));
    expect(decoded.steps[0]).not.toHaveProperty("interactionMode");
  });

  it.each([
    [
      "a forward reference",
      [step("a", "{{steps.b.output}}"), step("b", "x")],
      "does not run before",
    ],
    ["a self reference", [step("a", "{{steps.a.output}}")], "does not run before"],
    ["an unknown step", [step("a", "x"), step("b", "{{steps.nope.output}}")], "not a step"],
    ["an unknown variable", [step("a", "{{input.text}}")], "unknown variable"],
    ["previous.output in step 0", [step("a", "{{previous.output}}")], "nothing to read"],
    [
      "the plan agent",
      [
        step("a", "x", {
          modelSelection: {
            instanceId: "opencode",
            model: "gpt-5.4",
            options: [{ id: "agent", value: "plan" }],
          },
        }),
      ],
      "no plan mode",
    ],
    ["a duplicate id", [step("a", "x"), step("a", "y", { name: "Other" })], "id"],
    [
      "a duplicate name",
      [step("a", "x", { name: "Same" }), step("b", "y", { name: " same " })],
      "name",
    ],
    ["a bad skill name", [step("a", "x", { skills: ["123"] })], undefined],
    ["a skill name with a space", [step("a", "x", { skills: ["two words"] })], undefined],
    ["a bad step id", [step("Not Valid", "x")], undefined],
    ["no steps", [], undefined],
    [
      `more than ${PIPELINE_MAX_STEPS} steps`,
      Array.from({ length: PIPELINE_MAX_STEPS + 1 }, (_, i) => step(`s${i}`, "x")),
      undefined,
    ],
  ])("rejects %s", (_label, steps, message) => {
    const attempt = () => decodeUpsert(upsert(steps));
    expect(attempt).toThrow(message);
  });
});

describe("PipelineDefinition", () => {
  it("decodes a stored definition", () => {
    const decoded = decodeDefinition({
      id: "pipeline-1",
      name: "Review",
      steps: [step("a", "{{input}}")],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(decoded.steps).toHaveLength(1);
  });
});

describe("pipeline template helpers", () => {
  it("reads every placeholder kind, trimming whitespace", () => {
    expect(
      pipelineTemplateReferences(
        "{{input}} {{ previous.output }} {{steps. My Step .output}} {{x}}",
      ),
    ).toEqual([
      { kind: "input" },
      { kind: "previous" },
      { kind: "step", key: "My Step" },
      { kind: "unknown", expression: "x" },
    ]);
  });

  it.each([
    ["the id", "build", 1],
    ["the name, ignoring case and space", "  PLAN step ", 0],
    ["the id before another step's name", "build", 1],
    ["nothing", "missing", -1],
  ])("resolves %s", (_label, key, expected) => {
    const steps = [
      { id: "plan", name: "Plan step" },
      { id: "build", name: "plan" },
    ];
    expect(resolvePipelineStepKey(steps, key)).toBe(expected);
  });

  it("reports issues in step order", () => {
    expect(
      pipelineDefinitionIssues([
        { id: "a", name: "A", promptTemplate: "{{previous.output}}" },
        { id: "b", name: "B", promptTemplate: "{{steps.a.output}}" },
      ]).map((issue) => issue.stepId),
    ).toEqual(["a"]);
  });
});

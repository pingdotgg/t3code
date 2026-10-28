import {
  PIPELINE_MAX_STEPS,
  PipelineId,
  PipelineStepId,
  ProviderInstanceId,
  type PipelineDefinition,
} from "@t3tools/contracts";
import { FEATURE_DELIVERY_PIPELINE } from "@t3tools/shared/pipelineStarters";
import { describe, expect, it } from "vite-plus/test";

import {
  describePipelineSteps,
  draftToUpsertInput,
  emptyPipelineDraft,
  hasPipelineDraftChanges,
  moveStep,
  newStepDraft,
  normalizeSkillName,
  pipelineDraftIssues,
  pipelineStepSummary,
  pipelineToDraft,
  resolveStepIds,
  starterToDraft,
  slugifyStepName,
  uniqueStepId,
  type PipelineDraft,
  type PipelineStepDraft,
} from "./pipelineEditor.ts";

const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4" };
const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const defaults = { modelSelection: claude, runtimeMode: "full-access" } as const;

function idSequence() {
  let next = 0;
  return () => `id-${(next += 1)}`;
}

function step(overrides: Partial<PipelineStepDraft> & { name: string }): PipelineStepDraft {
  return {
    key: overrides.name,
    lockedId: null,
    modelSelection: claude,
    runtimeMode: "full-access",
    skills: [],
    promptTemplate: "{{input}}",
    pauseBefore: false,
    ...overrides,
  };
}

function draftOf(steps: ReadonlyArray<PipelineStepDraft>, name = "Ship it"): PipelineDraft {
  return { editingId: null, commandId: "command-1", name, steps };
}

describe("step ids", () => {
  it("slugifies names and numbers duplicates", () => {
    for (const [name, slug] of [
      ["  Plan the Work! ", "plan-the-work"],
      ["  Review & Fix! ", "review-fix"],
      ["日本語", "step"],
      ["!!!", "step"],
      ["a".repeat(60), "a".repeat(48)],
    ] as const) {
      expect(slugifyStepName(name)).toBe(slug);
    }
    expect(uniqueStepId("review", new Set(["review", "review-2"]))).toBe("review-3");
    expect(uniqueStepId("a".repeat(48), new Set(["a".repeat(48)]))).toBe(`${"a".repeat(46)}-2`);

    const ids = resolveStepIds([
      step({ name: "Plan" }),
      step({ name: "Review" }),
      step({ name: "review!" }),
    ]);
    expect(ids).toEqual(["plan", "review", "review-2"]);
  });

  it("keeps saved ids when a step is renamed and never reuses them for new steps", () => {
    const ids = resolveStepIds([
      step({ name: "Renamed", lockedId: "review" }),
      step({ name: "Review" }),
    ]);
    expect(ids).toEqual(["review", "review-2"]);
  });
});

describe("default steps", () => {
  it("reads the input first and the previous output after, inheriting model and mode", () => {
    const first = emptyPipelineDraft(defaults, idSequence()).steps;
    expect(first[0]?.promptTemplate).toBe("{{input}}");
    expect(first[0]?.name).toBe("Step 1");
    expect(emptyPipelineDraft(defaults, idSequence())).toMatchObject({
      editingId: null,
      commandId: "id-1",
      name: "",
      steps: [{ key: "id-2", lockedId: null }],
    });

    const second = newStepDraft(
      [{ ...first[0]!, modelSelection: codex, runtimeMode: "auto" }],
      defaults,
      idSequence(),
    );
    expect(second).toMatchObject({
      name: "Step 2",
      promptTemplate: "{{previous.output}}",
      modelSelection: codex,
      runtimeMode: "auto",
      lockedId: null,
    });
  });

  it("picks an unused default name after a removal", () => {
    const next = newStepDraft(
      [step({ name: "Step 2" }), step({ name: "Plan" })],
      defaults,
      idSequence(),
    );
    expect(next.name).toBe("Step 3");
  });
});

describe("form and input conversion", () => {
  it("builds a create input with a command id and generated ids", () => {
    const input = draftToUpsertInput(
      draftOf([
        step({ name: "Plan", skills: ["brainstorm"] }),
        step({
          name: "Implement",
          modelSelection: codex,
          promptTemplate: " Do {{previous.output}} ",
          pauseBefore: true,
        }),
      ]),
    );
    expect(input).toMatchObject({
      commandId: "command-1",
      name: "Ship it",
      steps: [
        { id: "plan", skills: ["brainstorm"], pauseBefore: false },
        {
          id: "implement",
          modelSelection: codex,
          promptTemplate: "Do {{previous.output}}",
          pauseBefore: true,
        },
      ],
    });
    expect(input).not.toHaveProperty("id");
  });

  it("round-trips a saved pipeline into an edit input", () => {
    const pipeline: PipelineDefinition = {
      id: PipelineId.make("pipeline-1"),
      name: "Ship it",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      steps: [
        {
          id: PipelineStepId.make("plan"),
          name: "Plan",
          modelSelection: claude,
          runtimeMode: "approval-required",
          skills: ["brainstorm"],
          promptTemplate: "{{input}}",
          pauseBefore: false,
        },
        {
          id: PipelineStepId.make("build"),
          name: "Implement",
          modelSelection: codex,
          runtimeMode: "full-access",
          skills: [],
          promptTemplate: "{{steps.plan.output}}",
          pauseBefore: true,
        },
      ],
    };
    const input = draftToUpsertInput(pipelineToDraft(pipeline, idSequence()));
    expect(input).toEqual({
      id: pipeline.id,
      requireExisting: true,
      name: pipeline.name,
      steps: pipeline.steps,
    });
  });

  it("turns a starter into a create input that keeps the step ids its prompts reference", () => {
    const input = draftToUpsertInput(starterToDraft(FEATURE_DELIVERY_PIPELINE, idSequence()));
    expect(input).toMatchObject({ commandId: "id-1", name: FEATURE_DELIVERY_PIPELINE.name });
    expect(input).not.toHaveProperty("id");
    expect(input?.steps).toEqual(FEATURE_DELIVERY_PIPELINE.steps);
  });

  it("returns null while the draft has issues", () => {
    expect(draftToUpsertInput(draftOf([step({ name: "Plan" })], " "))).toBeNull();
    expect(draftToUpsertInput(draftOf([]))).toBeNull();
  });
});

describe("draft issues", () => {
  it("reports per-step problems under the step key", () => {
    const issues = pipelineDraftIssues(
      draftOf([
        step({ name: "Plan", promptTemplate: "{{previous.output}}" }),
        step({ name: "plan", promptTemplate: "{{steps.later.output}} {{nope}}" }),
        step({ name: " ", modelSelection: null, promptTemplate: " " }),
      ]),
    );
    expect(issues.valid).toBe(false);
    expect(issues.steps.get("Plan")).toEqual([
      expect.stringContaining("{{previous.output}} has nothing to read"),
    ]);
    expect(issues.steps.get("plan")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("used more than once"),
        expect.stringContaining('"later", which is not a step'),
        expect.stringContaining("unknown variable {{nope}}"),
      ]),
    );
    expect(issues.steps.get(" ")).toEqual([
      "Give the step a name.",
      "Choose a model.",
      "Write a prompt template.",
    ]);
  });

  it("limits the step count and validates skill names", () => {
    const many = Array.from({ length: PIPELINE_MAX_STEPS + 1 }, (_, index) =>
      step({
        name: `Step ${index + 1}`,
        promptTemplate: index === 0 ? "{{input}}" : "{{previous.output}}",
      }),
    );
    expect(pipelineDraftIssues(draftOf(many)).stepCount).toContain(String(PIPELINE_MAX_STEPS));
    for (const [raw, normalized] of [
      [" $code-review ", "code-review"],
      ["/review", "review"],
      ["plugin:skill-1", "plugin:skill-1"],
      ["two words", null],
      ["123", null],
    ] as const) {
      expect(normalizeSkillName(raw)).toBe(normalized);
    }
    expect(
      pipelineDraftIssues(draftOf([step({ name: "Plan", skills: ["bad skill"] })])).valid,
    ).toBe(false);
    const tooManySkills = Array.from({ length: 9 }, (_, index) => `skill-${index}`);
    expect(
      pipelineDraftIssues(draftOf([step({ name: "Plan", skills: tooManySkills })])).steps.get(
        "Plan",
      ),
    ).toEqual(["A step has at most 8 skills."]);
  });

  it("lists every message flat, prefixing step messages with their step", () => {
    expect(pipelineDraftIssues(draftOf([step({ name: "Plan" })])).messages).toEqual([]);
    const steps = [
      step({ name: "Plan", modelSelection: null }),
      step({ name: " ", skills: ["x y"] }),
    ];
    expect(pipelineDraftIssues(draftOf(steps, " ")).messages).toEqual([
      "Give the pipeline a name.",
      "Plan: Choose a model.",
      "Step 2: Give the step a name.",
      "Step 2: A skill name has an invalid character.",
    ]);
    expect(pipelineDraftIssues(draftOf([])).messages).toEqual(["Add at least one step."]);
  });

  it("accepts a step that refers to an earlier step by name", () => {
    const issues = pipelineDraftIssues(
      draftOf([
        step({ name: "Plan" }),
        step({ name: "Build", promptTemplate: "{{steps.Plan.output}}" }),
      ]),
    );
    expect(issues.valid).toBe(true);
  });
});

describe("helpers", () => {
  it("moves steps and ignores moves past the ends", () => {
    expect(moveStep(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    const list = ["a", "b"];
    expect(moveStep(list, 0, -1)).toBe(list);
    expect(moveStep(list, 1, 1)).toBe(list);
  });

  it("detects edits to what would be saved, ignoring keys and command ids", () => {
    const initial = draftOf([step({ name: "Plan", modelSelection: codex })]);
    const reloaded = {
      ...initial,
      commandId: "other",
      steps: [{ ...initial.steps[0]!, key: "other" }],
    };
    expect(hasPipelineDraftChanges(initial, reloaded)).toBe(false);
    expect(
      hasPipelineDraftChanges(initial, {
        ...initial,
        steps: [{ ...initial.steps[0]!, pauseBefore: true }],
      }),
    ).toBe(true);
    expect(
      hasPipelineDraftChanges(initial, {
        ...initial,
        steps: [
          {
            ...initial.steps[0]!,
            modelSelection: { ...codex, options: [{ id: "reasoningEffort", value: "low" }] },
          },
        ],
      }),
    ).toBe(true);
  });

  it("describes steps for a list row", () => {
    expect(describePipelineSteps([])).toBe("0 steps");
    expect(describePipelineSteps([{ name: "Plan" }])).toBe("1 step: Plan");
    expect(describePipelineSteps([{ name: "Plan" }, { name: "Build" }])).toBe(
      "2 steps: Plan, Build",
    );
  });

  it("summarizes steps with known model labels", () => {
    const summary = pipelineStepSummary(
      [
        { name: "Plan", modelSelection: claude },
        { name: "Implement", modelSelection: codex },
        { name: "Review", modelSelection: { ...claude, model: "unknown" } },
      ],
      (selection) =>
        selection.model === "claude-opus-4"
          ? "Claude Opus"
          : selection.model === "gpt-5"
            ? "Codex"
            : null,
    );
    expect(summary).toBe("Plan (Claude Opus) → Implement (Codex) → Review");
  });
});

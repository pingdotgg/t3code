import type { ProviderOptionSelection, WorkflowDefinition } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { defaultBoardDefinition } from "./defaultBoard.ts";
import { BOARD_TEMPLATES, listBoardTemplateSummaries } from "./boardTemplates.ts";
import { lintWorkflowDefinition } from "./workflowFile.ts";

const baseAgent = { instance: "i", model: "m" } as const;

const lintErrors = (def: WorkflowDefinition) =>
  lintWorkflowDefinition(def, {
    providerInstanceExists: () => true,
    instructionFileExists: () => true,
  });

describe("BOARD_TEMPLATES", () => {
  it("registers the full-sdlc and lite-agent-loop templates", () => {
    assert.deepEqual(
      BOARD_TEMPLATES.map((t) => t.id),
      ["full-sdlc", "lite-agent-loop", "design-board", "design-board-full"],
    );
    for (const template of BOARD_TEMPLATES) {
      assert.equal(template.requiresAgent, true);
    }
  });

  for (const template of BOARD_TEMPLATES) {
    describe(template.id, () => {
      const def = template.build({ name: "X", agent: baseAgent });

      it("builds a lint-clean WorkflowDefinition", () => {
        assert.equal(def.name, "X");
        assert.deepEqual(lintErrors(def), []);
      });

      it("has every transition/on/action `to` target among the lane keys", () => {
        const laneKeys = new Set(def.lanes.map((lane) => lane.key as string));
        for (const lane of def.lanes) {
          for (const action of lane.actions ?? []) {
            assert.ok(laneKeys.has(action.to as string), `action ${action.to}`);
          }
          for (const transition of lane.transitions ?? []) {
            assert.ok(laneKeys.has(transition.to as string), `transition ${transition.to}`);
          }
          if (lane.on) {
            for (const target of [lane.on.success, lane.on.failure, lane.on.blocked]) {
              if (target !== undefined) {
                assert.ok(laneKeys.has(target as string), `on ${target}`);
              }
            }
          }
        }
      });
    });
  }

  it("lite-agent-loop bounds its review self-loop with lane.runCount", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "lite-agent-loop")!.build({
      name: "X",
      agent: baseAgent,
    });
    const inProgress = def.lanes.find((lane) => (lane.key as string) === "in-progress");
    assert.ok(inProgress);
    const transitions = inProgress.transitions ?? [];
    assert.ok(transitions.length >= 1);
    const loopTransition = transitions.find((t) => (t.to as string) === "in-progress");
    assert.ok(loopTransition, "expected a self-loop transition back to in-progress");
    assert.ok(JSON.stringify(loopTransition.when).includes("lane.runCount"));
  });

  it("full-sdlc.build deep-equals defaultBoardDefinition", () => {
    const fromTemplate = BOARD_TEMPLATES.find((t) => t.id === "full-sdlc")!.build({
      name: "X",
      agent: baseAgent,
    });
    assert.deepEqual(fromTemplate, defaultBoardDefinition({ name: "X", agent: baseAgent }));
  });

  it("threads agent.options through every agent step in BOTH templates", () => {
    const options: ReadonlyArray<ProviderOptionSelection> = [
      { id: "reasoning_effort", value: "high" },
    ];
    for (const template of BOARD_TEMPLATES) {
      const def = template.build({
        name: "X",
        agent: { instance: "i", model: "m", options },
      });
      let agentStepCount = 0;
      for (const lane of def.lanes) {
        for (const step of lane.pipeline ?? []) {
          if (step.type === "agent") {
            agentStepCount += 1;
            assert.deepEqual(step.agent.options, options, `${template.id} ${step.key}`);
          }
        }
      }
      assert.ok(agentStepCount > 0, `${template.id} should have agent steps`);
    }
  });

  const stepKeys = (def: WorkflowDefinition) =>
    def.lanes.flatMap((l) => (l.pipeline ?? []).map((s) => s.key as string));

  it("design-board has no AI review steps", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "design-board")!.build({
      name: "X",
      agent: baseAgent,
    });
    assert.deepEqual(
      stepKeys(def).filter((k) => k.endsWith("-review")),
      [],
    );
  });

  it("design-board-full has exactly the three review steps", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "design-board-full")!.build({
      name: "X",
      agent: baseAgent,
    });
    assert.deepEqual(
      stepKeys(def)
        .filter((k) => k.endsWith("-review"))
        .sort(),
      ["build-review", "plan-review", "spec-review"],
    );
  });

  it("design-board-full build lane guards the loop before the unguarded revise", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "design-board-full")!.build({
      name: "X",
      agent: baseAgent,
    });
    const build = def.lanes.find((l) => (l.key as string) === "build")!;
    // first transition must be the lane.runCount-guarded one
    assert.ok(JSON.stringify(build.transitions![0]).includes("lane.runCount"));
  });
});

describe("listBoardTemplateSummaries", () => {
  it("returns exactly the four template summaries", () => {
    assert.deepEqual(listBoardTemplateSummaries(), [
      {
        id: "full-sdlc",
        name: "Full SDLC",
        description: "Plan → spec → implement → review pipeline with a revision loop.",
        requiresAgent: true,
      },
      {
        id: "lite-agent-loop",
        name: "Lite agent loop",
        description: "To do → In progress (implement→review, loops on changes) → Done.",
        requiresAgent: true,
      },
      {
        id: "design-board",
        name: "Design board",
        description: "Idea → brainstorm → plan → build, with human approval gates.",
        requiresAgent: true,
      },
      {
        id: "design-board-full",
        name: "Design board (with AI review)",
        description: "Adds AI spec/plan/build reviews before each gate. Needs a capable agent.",
        requiresAgent: true,
      },
    ]);
  });
});

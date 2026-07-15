import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import {
  listBuiltinWorkflows,
  isBuiltinWorkflow,
  loadBuiltinWorkflow,
} from "../workflows/BuiltinWorkflows.ts";

describe("BuiltinWorkflows", () => {
  it("should list all built-in workflows", () => {
    const workflows = listBuiltinWorkflows();

    expect(workflows).toHaveLength(3);
    expect(workflows.map((w) => w.name)).toContain("code-review");
    expect(workflows.map((w) => w.name)).toContain("parallel-search");
    expect(workflows.map((w) => w.name)).toContain("multi-model-eval");
  });

  it("should provide descriptions for each workflow", () => {
    const workflows = listBuiltinWorkflows();

    for (const workflow of workflows) {
      expect(workflow.name).toBeTruthy();
      expect(workflow.description).toBeTruthy();
      expect(workflow.description.length).toBeGreaterThan(10);
    }
  });

  it("should detect built-in workflow names", () => {
    expect(isBuiltinWorkflow("code-review")).toBe(true);
    expect(isBuiltinWorkflow("parallel-search")).toBe(true);
    expect(isBuiltinWorkflow("multi-model-eval")).toBe(true);
    expect(isBuiltinWorkflow("unknown-workflow")).toBe(false);
    expect(isBuiltinWorkflow("")).toBe(false);
  });

  it("should have valid descriptions", () => {
    const workflows = listBuiltinWorkflows();

    const codeReview = workflows.find((w) => w.name === "code-review");
    expect(codeReview?.description).toContain("code review");

    const parallelSearch = workflows.find((w) => w.name === "parallel-search");
    expect(parallelSearch?.description).toContain("parallel");

    const multiModel = workflows.find((w) => w.name === "multi-model-eval");
    expect(multiModel?.description).toContain("model");
  });

  it.effect("loads and decodes every built-in workflow from its ESM module path", () =>
    Effect.gen(function* () {
      for (const name of ["code-review", "parallel-search", "multi-model-eval"] as const) {
        const workflow = yield* loadBuiltinWorkflow(name);
        expect(workflow.phases.length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

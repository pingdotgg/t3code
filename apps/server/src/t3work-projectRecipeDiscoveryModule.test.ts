// @effect-diagnostics nodeBuiltinImport:off - test harness reads a fixture workspace + temp dir.
/**
 * Proves the recipe-authoring vertical slice (Epic 16): a recipe hand-authored as a typed
 * `recipe.ts` + `.workflow.ts` is DISCOVERED through the catalog path and LAUNCHED through the
 * REAL engine launch path, end to end.
 *
 *   1. `discoverProjectRecipes` imports the worked-example `recipe.ts` module, ranks it via the
 *      locked matcher, and produces the same `ProjectRecipeDiscovered` shape recipe.json yields —
 *      including a resolved `workflowPath` pointing at the recipe's `defaultAction` workflow.
 *   2. That `workflowPath` runs through `launchWorkflowRecipe` (the production launch), parking on
 *      each ask and completing when replies land — the test plays the resume reactor's role, as in
 *      `t3work-workflowEngineLaunch.test.ts`.
 *
 * A compile-time block asserts `defineRecipe` is typed end to end: `defaultAction` must be a typed
 * `WorkflowRef` (a string is a compile error) and `defaults` is checked against the workflow's
 * `Inputs`. These `@ts-expect-error`s are enforced by `tsgo` (apps/server typechecks its tests).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { createQueryable } from "@t3tools/project-context";
import type { ProjectRecipeRenderContext } from "@t3tools/project-recipes";
import { type OrchestrationCommand, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { defineRecipe, type WorkflowRef } from "@t3work/sdk";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { discoverProjectRecipes } from "./t3work-projectRecipeDiscovery.ts";
import { launchWorkflowRecipe } from "./t3work-workflowEngineLaunch.ts";
import { makeWorkflowEngineRegistry } from "./t3work-workflowEngineRegistry.ts";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__");
const workspaceRoot = mkdtempSync(join(fixtureRoot, "t3work-recipe-module-workspace-"));
const runsRoot = mkdtempSync(join(tmpdir(), "t3work-recipe-module-"));
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(runsRoot, { recursive: true, force: true });
});

const recipeRoot = join(workspaceRoot, ".t3work", "recipes", "example-pr-review");
mkdirSync(recipeRoot, { recursive: true });
writeFileSync(
  join(recipeRoot, "example-pr-review.workflow.ts"),
  `
import { Schema } from "effect";

export const Inputs = Schema.Struct({ prTitle: Schema.String });

export const Outputs = Schema.Struct({
  summary: Schema.String,
  merged: Schema.Boolean,
});

export const meta = {
  name: "example.recipe.pr-review",
  description: "Summarize a PR in an isolated thread, then ask whether to merge.",
  inputs: Inputs,
  outputs: Outputs,
  capabilities: ["user"],
} as const;

const input = Schema.decodeSync(Inputs)(args);

const Summary = Schema.Struct({ summary: Schema.String });
const review = await agent(\`Review this pull request and summarize the risk: \${input.prTitle}\`, {
  schema: Summary,
});

if (thread === undefined)
  throw new Error("example.recipe.pr-review must run in a launching thread");

const Decision = Schema.Struct({ merge: Schema.Boolean });
const decision = await thread.askUser(\`Merge "\${input.prTitle}"?\\n\\n\${review.summary}\`, {
  schema: Decision,
});

return { summary: review.summary, merged: decision.merge };
`,
);
writeFileSync(
  join(recipeRoot, "recipe.ts"),
  `
import { defineRecipe, defineWorkflow } from "@t3work/sdk";

import type * as PrReviewWorkflow from "./example-pr-review.workflow.ts";

export default defineRecipe({
  id: "example-pr-review",
  version: "0.1.0",
  scope: "project",
  title: "Review a pull request",
  shortDescription: "Summarize a PR, then ask whether to merge.",
  icon: "git-pull-request",
  surfaces: ["workitem.detail.sidepanel"],
  rank: 70,
  appliesTo: {
    requiresIntegration: ["jira"],
    jiraIssueTypes: ["Bug", "Story"],
  },
  allowedToolGroups: ["integration.read"],
  slashAlias: "pr-review",
  defaultAction: defineWorkflow<typeof PrReviewWorkflow>("./example-pr-review.workflow.ts"),
  defaults: { prTitle: "Untitled pull request" },
});
`,
);

// A jira-integrated work-item detail surface — matches the worked example's `appliesTo`.
const renderContext: ProjectRecipeRenderContext = {
  surface: "workitem.detail.sidepanel",
  project: { title: "Project Alpha", provider: "jira" },
  workitem: {
    kind: "ticket",
    displayId: "ALPHA-42",
    type: "Bug",
    priority: "High",
    provider: "jira",
  },
  linkedResources: createQueryable([]),
  artifacts: createQueryable([]),
  profile: {
    technicalDepth: "medium",
    brevity: "balanced",
    guidanceStyle: "guided",
    detailDensity: "balanced",
    preferredArtifactKinds: [],
    defaultActionFamilies: [],
    defaultRecipeWeights: {},
  },
  enabledSkillPacks: [],
  schema: {},
  availableContextKeys: createQueryable([]),
};

describe("recipe.ts discovery + engine launch", () => {
  it("discovers the worked-example recipe.ts and launches its .workflow.ts through the engine", async () => {
    // ── 1. Discover the typed recipe.ts module ────────────────────────────────
    const discovered = await Effect.runPromise(
      Effect.scoped(
        discoverProjectRecipes({ workspaceRoot, context: renderContext }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    );

    expect(discovered.hasProjectLocalRecipes).toBe(true);
    const recipe = discovered.recipes.find((entry) => entry.id === "example-pr-review");
    expect(recipe).toBeDefined();
    expect(recipe).toMatchObject({
      id: "example-pr-review",
      version: "0.1.0",
      source: "project-local",
      displayName: "Review a pull request",
      shortDescription: "Summarize a PR, then ask whether to merge.",
      icon: "git-pull-request",
      allowedToolGroups: ["integration.read"],
    });
    expect(recipe!.rank).toBeGreaterThan(0);
    // The `defaultAction` WorkflowRef resolved to the recipe's `.workflow.ts` on disk.
    expect(recipe!.workflowPath).toMatch(/example-pr-review\.workflow\.ts$/);

    // ── 2. Launch the discovered workflow through the real engine path ─────────
    const registry = makeWorkflowEngineRegistry();
    const dispatched: OrchestrationCommand[] = [];
    const dispatch = async (command: OrchestrationCommand): Promise<void> => {
      dispatched.push(command);
    };
    let seq = 0;
    let completed: unknown;

    const runId = "wf-recipe-run";
    const launchThreadId = "launch-recipe-1";
    const result = await launchWorkflowRecipe({
      runId,
      workflowPath: recipe!.workflowPath!,
      args: { prTitle: "Fix the billing rounding bug" },
      runsRoot,
      launchThreadId,
      projectId: ProjectId.make("proj-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("inst-1"), "model-x"),
      runtimeMode: "full-access",
      interactionMode: "default",
      registry,
      dispatch,
      newId: () => `id-${(seq += 1)}`,
      nowIso: () => "2026-01-01T00:00:00.000Z",
      onComplete: async (output) => {
        completed = output;
      },
    });

    // Parks on the agent's isolated-thread turn.
    expect(result.status).toBe("suspended");
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);

    const run = registry.getRun(runId);
    expect(run).toBeDefined();

    // Reactor step 1: the agent turn completes on the spawned thread (`${runId}:1`).
    const agentAsk = registry.takePending(`${runId}:1`);
    expect(agentAsk?.kind).toBe("thread.turn");
    await run!.resume(agentAsk!.correlationId, { summary: "Low risk; well tested." });

    // The user escalation fired as a system message into the launching thread.
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.message.upsert",
    ]);

    // Reactor step 2: the user replies in the launching thread.
    const userAsk = registry.takePending(launchThreadId);
    expect(userAsk?.kind).toBe("user.input");
    await run!.resume(userAsk!.correlationId, { merge: true });

    expect(completed).toEqual({ summary: "Low risk; well tested.", merged: true });
    expect(registry.getRun(runId)).toBeUndefined(); // completed runs are unregistered
  });

  it("types defaultAction + defaults against the workflow contract (compile-time)", () => {
    // A typed workflow ref standing in for `defineWorkflow<typeof Module>(...)` (whose `.workflow.ts`
    // body uses ambient engine globals and so cannot be type-imported into a typechecked file).
    const typedAction = { kind: "workflow", path: "x", absolutePath: "x" } as WorkflowRef<
      { prTitle: string },
      { summary: string; merged: boolean }
    >;

    const ok = defineRecipe({
      id: "compile-check",
      version: "0.0.0",
      title: "Compile check",
      shortDescription: "d",
      surfaces: ["workitem.detail.sidepanel"],
      defaultAction: typedAction,
      defaults: { prTitle: "ok" },
    });
    expect(ok.defaultAction).toBe(typedAction);
    expect(ok.defaults).toEqual({ prTitle: "ok" });

    // These never execute — they assert that wrong shapes fail to typecheck.
    const _rejected = (): ReadonlyArray<unknown> => [
      defineRecipe({
        id: "x",
        version: "1",
        title: "X",
        shortDescription: "d",
        surfaces: [],
        // @ts-expect-error — defaultAction must be a typed WorkflowRef, not a string
        defaultAction: "pr-review",
      }),
      defineRecipe({
        id: "x",
        version: "1",
        title: "X",
        shortDescription: "d",
        surfaces: [],
        defaultAction: typedAction,
        // @ts-expect-error — default input must match the workflow's `Inputs`
        defaults: { prTitle: 123 },
      }),
      defineRecipe({
        id: "x",
        version: "1",
        title: "X",
        shortDescription: "d",
        surfaces: [],
        defaultAction: typedAction,
        // @ts-expect-error — unknown default input key
        defaults: { nope: true },
      }),
    ];
    void _rejected;
  });
});

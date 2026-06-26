import { describe, expect, it } from "vite-plus/test";

import {
  defineRecipe,
  getRegisteredRecipe,
  listRegisteredRecipes,
  type WorkflowRef,
} from "./t3work-sdk.index.ts";

// A typed workflow ref standing in for `defineWorkflow<typeof Module>(...)` without touching disk.
const prReviewAction = {
  kind: "workflow",
  path: "./pr.workflow.ts",
  absolutePath: "/abs/pr.workflow.ts",
} as WorkflowRef<{ prTitle: string }, { summary: string; merged: boolean }>;

describe("defineRecipe", () => {
  it("returns a frozen recipe ref, defaulting scope to project", () => {
    const recipe = defineRecipe({
      id: "define-recipe-basic",
      version: "0.1.0",
      title: "Review a pull request",
      shortDescription: "Summarize a PR, then ask whether to merge.",
      surfaces: ["workitem.detail.sidepanel"],
      icon: "git-pull-request",
      rank: 70,
      appliesTo: { requiresIntegration: ["jira"], jiraIssueTypes: ["Bug", "Story"] },
      allowedToolGroups: ["integration.read"],
      slashAlias: "pr-review",
      defaultAction: prReviewAction,
      defaults: { prTitle: "Untitled" },
    });

    expect(recipe.kind).toBe("recipe");
    expect(recipe.scope).toBe("project");
    expect(recipe.title).toBe("Review a pull request");
    expect(recipe.surfaces).toEqual(["workitem.detail.sidepanel"]);
    expect(recipe.defaultAction).toBe(prReviewAction);
    expect(recipe.defaults).toEqual({ prTitle: "Untitled" });
    expect(Object.isFrozen(recipe)).toBe(true);
  });

  it("registers the recipe and re-registers (upsert, last-wins) without throwing", () => {
    defineRecipe({
      id: "define-recipe-upsert",
      version: "0.1.0",
      title: "First",
      shortDescription: "first",
      surfaces: ["thread.context"],
      defaultAction: prReviewAction,
    });
    expect(getRegisteredRecipe("define-recipe-upsert")?.title).toBe("First");

    // Discovery re-imports recipe.ts on every render-context change, so the same id legitimately
    // re-registers — this must NOT throw (unlike defineTool's duplicate guard).
    const second = defineRecipe({
      id: "define-recipe-upsert",
      version: "0.2.0",
      title: "Second",
      shortDescription: "second",
      surfaces: ["thread.context"],
      defaultAction: prReviewAction,
    });
    expect(getRegisteredRecipe("define-recipe-upsert")).toBe(second);
    expect(getRegisteredRecipe("define-recipe-upsert")?.title).toBe("Second");
    expect(listRegisteredRecipes().some((entry) => entry.id === "define-recipe-upsert")).toBe(true);
  });

  it("rejects empty id, empty version, and non-project scope", () => {
    const base = {
      version: "0.1.0",
      title: "T",
      shortDescription: "d",
      surfaces: ["thread.context"],
      defaultAction: prReviewAction,
    } as const;

    expect(() => defineRecipe({ ...base, id: "  " })).toThrow(/non-empty id/);
    expect(() => defineRecipe({ ...base, id: "ok", version: "" })).toThrow(/non-empty version/);
    expect(() =>
      // @ts-expect-error — only project scope is supported; this also asserts the runtime guard.
      defineRecipe({ ...base, id: "ok2", scope: "personal" }),
    ).toThrow(/project-scoped/);
  });
});

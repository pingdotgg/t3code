#!/usr/bin/env node
/**
 * Creates a temp workspace with a discoverable timer recipe for browser/API E2E.
 * Usage: node scripts/t3work-timer-e2e-workspace.mjs
 * Prints WORKSPACE_ROOT=<path> to stdout.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const fixtureWorkflow = NodePath.join(
  repoRoot,
  "apps/server/__fixtures__/t3work-exampleTimer.workflow.ts",
);
const fixturesDir = NodePath.join(repoRoot, "apps/server/__fixtures__");
const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(fixturesDir, "t3work-timer-e2e-"));
const recipeRoot = NodePath.join(workspaceRoot, ".t3work", "recipes", "example-timer");

NodeFS.mkdirSync(recipeRoot, { recursive: true });
NodeFS.cpSync(fixtureWorkflow, NodePath.join(recipeRoot, "example-timer.workflow.ts"));

NodeFS.writeFileSync(
  NodePath.join(recipeRoot, "recipe.ts"),
  `import { defineRecipe, defineWorkflow } from "@t3work/sdk";

import type * as TimerWorkflow from "./example-timer.workflow.ts";

export default defineRecipe({
  id: "example-timer",
  version: "0.1.0",
  scope: "project",
  title: "Sleeping timer demo",
  shortDescription: "Park on waitUntil, then complete after a short delay.",
  icon: "timer",
  surfaces: ["project.dashboard.backlog"],
  rank: 90,
  appliesTo: {},
  allowedToolGroups: [],
  defaultAction: defineWorkflow<typeof TimerWorkflow>("./example-timer.workflow.ts"),
  defaults: { delayMs: 2000 },
});
`,
);

console.log(`WORKSPACE_ROOT=${workspaceRoot}`);

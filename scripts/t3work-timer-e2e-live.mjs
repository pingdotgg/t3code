#!/usr/bin/env node
/**
 * Live sleeping-routine E2E against a running t3work server.
 *
 * Usage:
 *   node scripts/t3work-timer-e2e-workspace.mjs   # prints WORKSPACE_ROOT
 *   T3WORK_PAIRING_TOKEN=<token> node scripts/t3work-timer-e2e-live.mjs
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  buildDiscoverContext,
  extractSessionCookie,
  fetchJson,
  findSqliteDb,
  queryWorkflowRun,
  sleep,
} from "./t3work-timer-e2e-live-lib.mjs";

const repoRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.T3WORK_SERVER_URL ?? "http://localhost:3773";
const pairingToken = process.env.T3WORK_PAIRING_TOKEN?.trim();
const delayMs = Number(process.env.T3WORK_DELAY_MS ?? "2000");

if (!pairingToken) {
  console.error("T3WORK_PAIRING_TOKEN is required (see server startup pairingUrl).");
  process.exit(1);
}

const workspaceRoot =
  process.env.T3WORK_WORKSPACE_ROOT?.trim() ||
  NodeChildProcess.execSync("node scripts/t3work-timer-e2e-workspace.mjs", {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .find((line) => line.startsWith("WORKSPACE_ROOT="))
    ?.slice("WORKSPACE_ROOT=".length)
    ?.trim();

if (!workspaceRoot) {
  console.error("Failed to resolve workspace root.");
  process.exit(1);
}

const workflowPath = NodePath.join(
  workspaceRoot,
  ".t3work/recipes/example-timer/example-timer.workflow.ts",
);

async function main() {
  console.log(`workspace=${workspaceRoot}`);

  const { response: sessionResponse } = await fetchJson(baseUrl, "/api/auth/browser-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: pairingToken }),
  });
  const cookie = extractSessionCookie(sessionResponse);

  await fetchJson(baseUrl, "/api/t3work/project/workspace/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceRoot }),
  });

  const { body: discover } = await fetchJson(
    baseUrl,
    "/api/t3work/project/workspace/recipes/discover",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceRoot,
        context: buildDiscoverContext(workspaceRoot),
      }),
    },
  );
  const recipeCount = discover.recipes?.length ?? 0;
  console.log(
    `discover: hasProjectLocalRecipes=${discover.hasProjectLocalRecipes} recipes=${recipeCount}`,
  );
  if (!discover.hasProjectLocalRecipes || recipeCount === 0) {
    throw new Error("Timer recipe not discoverable in workspace.");
  }

  const stamp = Date.now();
  const projectId = `proj-timer-e2e-${stamp}`;
  const threadId = `thread-timer-e2e-${stamp}`;
  const now = new Date().toISOString();
  const modelSelection = { instanceId: "codex", model: "gpt-5" };

  const dispatch = (command) =>
    fetchJson(baseUrl, "/api/orchestration/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(command),
    });

  await dispatch({
    type: "project.create",
    commandId: `cmd-proj-${stamp}`,
    projectId,
    title: "Timer E2E",
    workspaceRoot,
    defaultModelSelection: modelSelection,
    createdAt: now,
  });
  await dispatch({
    type: "thread.create",
    commandId: `cmd-thread-${stamp}`,
    threadId,
    projectId,
    title: "Timer launch",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  });

  const { body: launch } = await fetchJson(baseUrl, "/api/t3work/thread/recipe-workflow/launch", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      threadId,
      modelSelection,
      launch: { workflowPath, parameters: { delayMs } },
    }),
  });
  const runId = launch.runId;
  if (!runId) throw new Error(`Launch missing runId: ${JSON.stringify(launch)}`);
  console.log(`launch: runId=${runId}`);

  const dbPath = findSqliteDb();
  if (!dbPath) throw new Error("Could not locate SQLite DB with workflow_runs.");
  console.log(`db=${dbPath}`);

  let sawSleeping = false;
  const deadline = Date.now() + delayMs + 8000;
  while (Date.now() < deadline) {
    const row = queryWorkflowRun(dbPath, runId);
    if (row) {
      if (row.status === "sleeping") sawSleeping = true;
      console.log(`poll: status=${row.status} wake_at=${row.wakeAt ?? "null"}`);
      if (row.status === "completed") break;
    }
    await sleep(400);
  }

  const final = queryWorkflowRun(dbPath, runId);
  console.log(`final: ${JSON.stringify(final)}`);
  console.log(
    `context: workspace=${workspaceRoot} projectId=${projectId} threadId=${threadId} runId=${runId}`,
  );

  if (!sawSleeping) {
    console.error("FAIL: never observed sleeping status.");
    process.exit(1);
  }
  if (final?.status !== "completed") {
    console.error(`FAIL: expected completed, got ${final?.status ?? "missing"}.`);
    process.exit(1);
  }
  console.log("PASS: sleeping → completed timer workflow E2E.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

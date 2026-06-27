import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export async function fetchJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} → ${response.status}: ${text}`);
  }
  return { response, body };
}

export function extractSessionCookie(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const setCookie = raw.length > 0 ? raw : [response.headers.get("set-cookie")].filter(Boolean);
  for (const header of setCookie) {
    const match = header.match(/t3_session=[^;]+/);
    if (match) return match[0];
  }
  throw new Error("browser-session did not return t3_session cookie");
}

export function findSqliteDb() {
  const candidates = [
    NodePath.join(NodeOS.homedir(), ".t3/userdata/state.sqlite"),
    NodePath.join(NodeOS.homedir(), ".t3/dev/state.sqlite"),
  ];
  for (const file of candidates) {
    if (!NodeFS.existsSync(file)) continue;
    try {
      const tables = NodeChildProcess.execSync(`sqlite3 "${file}" ".tables"`, {
        encoding: "utf8",
      });
      if (tables.includes("workflow_runs")) return file;
    } catch {
      // try next
    }
  }
  return null;
}

export function queryWorkflowRun(dbPath, runId) {
  const row = NodeChildProcess.execSync(
    `sqlite3 "${dbPath}" "SELECT status, wake_at FROM workflow_runs WHERE run_id='${runId}';"`,
    { encoding: "utf8" },
  ).trim();
  if (!row) return null;
  const [status, wakeAt] = row.split("|");
  return { status, wakeAt: wakeAt || null };
}

export function buildDiscoverContext(workspaceRoot) {
  return {
    surface: "project.dashboard.backlog",
    project: { title: "Timer E2E", workspaceRoot },
    linkedResources: [],
    artifacts: [],
    surfaceState: {
      dashboardMode: "backlog",
      hasContextAttachments: false,
      hasSelectedWork: false,
      currentView: { itemCount: 0, bugCount: 0 },
    },
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
    availableContextKeys: [],
  };
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

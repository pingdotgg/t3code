#!/usr/bin/env node
// Visual fixture only: projection rows do not replace orchestration business-behavior tests.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    "base-dir": { type: "string" },
    "workspace-root": { type: "string" },
  },
});
if (
  !values["base-dir"] ||
  !values["workspace-root"] ||
  !NodePath.isAbsolute(values["workspace-root"])
) {
  throw new Error(
    "Usage: node apps/web/test/fixtures/archived-thread-links/seed.mjs --base-dir <stopped isolated T3 home> --workspace-root <absolute directory>",
  );
}
const base = NodeFS.realpathSync(values["base-dir"]);
// Canonicalize both sides so a symlinked live home cannot slip past the lexical check.
const sharedPath = NodePath.resolve(NodeOS.homedir(), ".t3");
const shared = NodeFS.existsSync(sharedPath) ? NodeFS.realpathSync(sharedPath) : sharedPath;
const fromShared = NodePath.relative(shared, base);
if (
  fromShared === "" ||
  (fromShared !== ".." &&
    !fromShared.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(fromShared))
)
  throw new Error("Use an isolated T3 home.");
const runtimePath = NodePath.join(base, "userdata/server-runtime.json");
if (NodeFS.existsSync(runtimePath)) {
  const { pid } = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"));
  if (Number.isInteger(pid)) {
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") running = false;
      else throw error;
    }
    if (running) throw new Error("Stop this sandbox's server before seeding projections.");
  }
}
const databasePath = NodePath.join(base, "userdata/statev2.sqlite");
if (!NodeFS.existsSync(databasePath))
  throw new Error("Start the isolated server once to run migrations, then stop it.");
const db = new NodeSqlite.DatabaseSync(databasePath);
const backupPath = `${databasePath}.archived-links-${Date.now()}.backup`;
await NodeSqlite.backup(db, backupPath);
const at = "2026-10-20T12:00:00.000Z";
const projectId = "fixture-16443-project";
const archivedId = "fixture-16443-archived";
const activeId = "fixture-16443-active";
const runId = "fixture-16443-run";
const rootId = "fixture-16443-root";
const modelSelection = { instanceId: "codex", model: "gpt-6-astra" };

function write(table, columns, payload) {
  const row =
    payload === undefined ? columns : { ...columns, payload_json: JSON.stringify(payload) };
  const names = Object.keys(row);
  db.prepare(
    `INSERT OR REPLACE INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...Object.values(row));
}
function thread(id, title, archivedAt) {
  const payload = {
    createdBy: "system",
    creationSource: "server",
    id,
    projectId,
    title,
    providerInstanceId: "codex",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    pullRequests: [],
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    titleRegeneration: null,
    deletedAt: null,
  };
  write(
    "orchestration_v2_projection_threads",
    {
      thread_id: id,
      project_id: projectId,
      title,
      default_provider: "codex",
      provider_instance_id: "codex",
      runtime_mode: "full-access",
      interaction_mode: "default",
      active_provider_thread_id: null,
      created_at: at,
      updated_at: at,
      archived_at: archivedAt,
      deleted_at: null,
    },
    payload,
  );
}

db.exec("BEGIN IMMEDIATE");
try {
  write("projection_projects", {
    project_id: projectId,
    title: "Archived thread links fixture",
    workspace_root: NodeFS.realpathSync(values["workspace-root"]),
    scripts_json: "[]",
    created_at: at,
    updated_at: at,
    deleted_at: null,
  });
  thread(archivedId, "Archive link reproduction fixture", at);
  thread(activeId, "Active link control fixture", null);
  const run = {
    id: runId,
    threadId: archivedId,
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection,
    providerThreadId: null,
    userMessageId: "fixture-16443-user",
    rootNodeId: rootId,
    activeAttemptId: null,
    status: "completed",
    queuePosition: null,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  };
  write(
    "orchestration_v2_projection_runs",
    {
      run_id: runId,
      thread_id: archivedId,
      ordinal: 1,
      provider: "codex",
      provider_instance_id: "codex",
      provider_thread_id: null,
      status: "completed",
      requested_at: at,
      completed_at: at,
    },
    run,
  );
  for (const [index, role, text] of [
    [
      0,
      "user",
      "Reply with exactly: Archive link reproduction fixture. Do not use tools or change files.",
    ],
    [1, "assistant", "Archive link reproduction fixture."],
  ]) {
    const id = index === 0 ? "fixture-16443-user" : "fixture-16443-assistant";
    const nodeId = index === 0 ? rootId : "fixture-16443-response";
    const node = {
      id: nodeId,
      threadId: archivedId,
      runId,
      parentNodeId: index === 0 ? null : rootId,
      rootNodeId: rootId,
      kind: index === 0 ? "root_turn" : "assistant_message",
      status: "completed",
      countsForRun: index === 0,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: at,
      completedAt: at,
    };
    write(
      "orchestration_v2_projection_nodes",
      {
        node_id: nodeId,
        thread_id: archivedId,
        run_id: runId,
        parent_node_id: node.parentNodeId,
        root_node_id: rootId,
        kind: node.kind,
        status: "completed",
        started_at: at,
        completed_at: at,
      },
      node,
    );
    const creation = {
      createdBy: index === 0 ? "user" : "agent",
      creationSource: index === 0 ? "web" : "provider",
    };
    const message = {
      ...creation,
      id,
      threadId: archivedId,
      runId,
      nodeId,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    };
    write(
      "orchestration_v2_projection_messages",
      {
        message_id: id,
        thread_id: archivedId,
        run_id: runId,
        node_id: nodeId,
        role,
        streaming: 0,
        created_at: at,
        updated_at: at,
      },
      message,
    );
    const item = {
      id: `fixture-16443-item-${index}`,
      threadId: archivedId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1000001 + index,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: `${role === "user" ? "user" : "assistant"}_message`,
      messageId: id,
      text,
      ...(index === 0
        ? { ...creation, inputIntent: "turn_start", attachments: [] }
        : { streaming: false }),
    };
    write(
      "orchestration_v2_projection_turn_items",
      {
        turn_item_id: item.id,
        thread_id: archivedId,
        run_id: runId,
        node_id: nodeId,
        ordinal: item.ordinal,
        type: item.type,
        status: "completed",
        updated_at: at,
      },
      item,
    );
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
console.log(
  JSON.stringify({
    backupPath,
    archivedId,
    activeId,
    route: "/<environmentId>/fixture-16443-archived",
  }),
);

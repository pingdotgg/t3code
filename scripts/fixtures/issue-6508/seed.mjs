// Historical projections are visual fixtures; only real app commands prove submission.
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ConversationMessageJson,
} from "../../../packages/contracts/src/orchestrationV2.ts";
import { ServerSettings } from "../../../packages/contracts/src/settings.ts";
import * as NodeModule from "node:module";
const require = NodeModule.createRequire(
  new URL("../../../packages/contracts/package.json", import.meta.url),
);
const Schema = await import(require.resolve("effect/Schema"));
const validate = (schema, value) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(JSON.stringify(value));
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
const [homeArg, preset = "H", environment = "E1"] = process.argv.slice(2);
if (!homeArg || !["H", "N", "P"].includes(preset) || !["E1", "E2"].includes(environment))
  throw Error(
    "Usage: node scripts/fixtures/issue-6508/seed.mjs /tmp/issue-6508-evidence/<home> H|N|P E1|E2 (server stopped, migrations complete)",
  );
const home = NodePath.resolve(homeArg);
if (!home.startsWith("/tmp/issue-6508-evidence/")) throw Error("Disposable proof homes only");
const state = NodePath.join(home, "userdata");
const catalog = JSON.parse(NodeFS.readFileSync(new URL("./catalog.json", import.meta.url)));
const selection = (model, effort) => ({
  instanceId: "codex",
  model,
  options: [{ id: "reasoningEffort", value: effort }],
});
const H = selection("gpt-6.1-sol", "high"),
  J = selection("gpt-6-luna", "low"),
  F = selection("gpt-6-astra", "medium");
for (const s of [H, J, F])
  if (!catalog.manifest.currentModels.codex.includes(s.model))
    throw Error("Model absent in frozen real manifest");
const now = "2026-10-22T10:00:00.000Z";
const projects = ["A", "B", "Unused"].map((n) => ({
  id: `proof-${environment}-${n}`,
  title: `Project ${n}`,
  root: `/tmp/issue-6508-evidence/workspaces/${environment}/${n}`,
}));
for (const p of projects) {
  NodeFS.mkdirSync(p.root, { recursive: true });
  try {
    NodeChildProcess.execFileSync("git", ["-C", p.root, "rev-parse", "--git-dir"], {
      stdio: "ignore",
    });
  } catch {
    NodeChildProcess.execFileSync("git", ["init", "-b", "main", p.root], { stdio: "ignore" });
    NodeFS.writeFileSync(
      NodePath.join(p.root, "README.md"),
      `# ${p.title}\nDeterministic issue 6508 fixture.\n`,
    );
    NodeChildProcess.execFileSync("git", ["-C", p.root, "add", "README.md"]);
    NodeChildProcess.execFileSync(
      "git",
      [
        "-C",
        p.root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Fixture workspace",
      ],
      { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now } },
    );
  }
}
const d = new NodeSqlite.DatabaseSync(NodePath.join(state, "statev2.sqlite"));
const tables = d
  .prepare("select name from sqlite_schema where type='table' and name like 'orchestration_%'")
  .all();
d.exec("BEGIN IMMEDIATE");
for (const { name } of tables) d.exec(`DELETE FROM "${name}"`);
d.exec("DELETE FROM projection_projects");
for (const p of projects)
  d.prepare(
    "INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(p.id, p.title, p.root, "[]", now, now);
const threads = [];
function add(label, project, tuple, runtime, interaction, authored, updated, kind = "user") {
  const id = `proof-${environment}-${label}`;
  const t = {
    createdBy: kind === "automation" ? "system" : "user",
    creationSource: "web",
    id,
    projectId: projects[project].id,
    title: label,
    providerInstanceId: "codex",
    modelSelection: tuple,
    runtimeMode: runtime,
    interactionMode: interaction,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: kind === "subagent" ? `proof-${environment}-A history` : null,
      relationshipToParent: kind === "subagent" ? "subagent" : null,
      rootThreadId: kind === "subagent" ? `proof-${environment}-A history` : id,
    },
    forkedFrom: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: updated,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  validate(OrchestrationV2AppThreadJson, t);
  d.prepare(
    "INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    t.projectId,
    label,
    "codex",
    "codex",
    runtime,
    interaction,
    t.createdAt,
    updated,
    JSON.stringify(t),
  );
  if (authored) {
    const m = {
      createdBy: kind === "automation" ? "system" : "user",
      creationSource: "web",
      id: `${id}-message`,
      threadId: id,
      runId: null,
      nodeId: null,
      role: "user",
      text: `${label}: deterministic history fixture, no provider is running.`,
      attachments: [],
      streaming: false,
      createdAt: authored,
      updatedAt: authored,
    };
    validate(OrchestrationV2ConversationMessageJson, m);
    d.prepare(
      "INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?)",
    ).run(m.id, id, "user", 0, authored, authored, JSON.stringify(m));
  }
  threads.push(t);
}
if (preset !== "N") {
  add("A history", 0, H, "auto", "plan", "2026-10-22T09:00:00.000Z", "2026-10-22T09:00:00.000Z");
  add(
    "A renamed older",
    0,
    J,
    "approval-required",
    "default",
    "2026-10-21T09:00:00.000Z",
    "2026-10-22T09:50:00.000Z",
  );
  add(
    "A automated decoy",
    0,
    F,
    "full-access",
    "default",
    "2026-10-22T09:55:00.000Z",
    "2026-10-22T09:55:00.000Z",
    "automation",
  );
  add(
    "A subagent decoy",
    0,
    F,
    "full-access",
    "default",
    "2026-10-22T09:56:00.000Z",
    "2026-10-22T09:56:00.000Z",
    "subagent",
  );
}
add(
  "B viewed history",
  1,
  J,
  "approval-required",
  "default",
  "2026-10-22T08:00:00.000Z",
  "2026-10-22T08:00:00.000Z",
);
d.exec("COMMIT");
d.close();
const settings = {
  defaultModelSelection: F,
  defaultRuntimeMode: "full-access",
  projectSettingsFolded: false,
  projectSettingsOverrides:
    preset === "P"
      ? { [projects[0].id]: { defaultModelSelection: J, defaultRuntimeMode: "approval-required" } }
      : {},
  providerInstances: {
    codex: {
      driver: "codex",
      enabled: true,
      config: {
        binaryPath: NodePath.join(home, "codex-fixture"),
        homePath: NodePath.join(home, "codex-home"),
      },
    },
    claudeAgent: { driver: "claudeAgent", enabled: false },
  },
};
validate(ServerSettings, settings);
NodeFS.mkdirSync(NodePath.join(home, "codex-home"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(state, "settings.json"),
  JSON.stringify(settings, null, 2) + "\n",
);
NodeFS.writeFileSync(NodePath.join(state, "environment-id"), `issue-6508-${environment}\n`);
NodeFS.copyFileSync(
  new URL("./catalog.json", import.meta.url),
  NodePath.join(state, "model-manifest.json"),
);
NodeFS.writeFileSync(
  NodePath.join(home, "codex-fixture"),
  `#!/bin/sh\nexec node '${NodeURL.fileURLToPath(new URL("./provider.mjs", import.meta.url)).replaceAll("'", `'"'"'`)}' "$@"\n`,
  { mode: 0o755 },
);
const manifest = {
  version: 1,
  preset,
  environmentId: `issue-6508-${environment}`,
  clock: now,
  clockMechanism:
    "Date constructor and Date.now in owned web page; timers remain real (native not frozen)",
  projects,
  threads,
  H,
  J,
  F,
  settings,
  catalogHash: NodeCrypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
  seedHash: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(new URL("./seed.mjs", import.meta.url)))
    .digest("hex"),
};
NodeFS.writeFileSync(
  NodePath.join(home, "seed-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    home,
    preset,
    environmentId: manifest.environmentId,
    projects: projects.map((p) => p.id),
    seedHash: manifest.seedHash,
    catalogHash: manifest.catalogHash,
  }),
);

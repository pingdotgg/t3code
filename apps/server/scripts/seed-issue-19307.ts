#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone repro CLI that seeds an isolated .t3 database before any server runs.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { OrchestrationV2ThreadProjectionJson } from "@t3tools/contracts";
import {
  browserInstaller,
  buildChildFixture,
  buildFixture,
  namespace,
  fixtureNames,
  timestamp,
} from "./fixtures/issue-19307.ts";

// Usage: node apps/server/scripts/seed-issue-19307.ts validate F1 running
//        ... seed F1 running /absolute/worktree/.t3
//        ... assert F1 running /absolute/worktree/.t3
// assert is read-only and intentionally usable after startup recovery.
const [mode = "validate", fixture = "F1", phase = "running", destination] = process.argv.slice(2);
if (mode === "browser") {
  const data = Object.fromEntries(
    (fixture === "all" ? fixtureNames : [fixture]).flatMap((name) =>
      ["idle", "queued", "preparing", "starting", "running", "waiting"].map((status) => [
        `${name}:${status}`,
        buildFixture(name, status),
      ]),
    ),
  );
  const installer = `(${browserInstaller})(${JSON.stringify(data)},${JSON.stringify(NodePath.resolve(import.meta.dirname, "../../.."))})\n`;
  // Pipe writes are asynchronous; exiting before the callback truncates the installer.
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(installer, (error) => (error ? reject(error) : resolve())),
  );
  process.exit(0);
}
if (!["validate", "seed", "assert"].includes(mode))
  throw new Error("Use validate, seed, assert or browser");
const projection = buildFixture(fixture, phase);
Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson)(projection);
const checksum = NodeCrypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex");
if (mode !== "validate") {
  if (!destination) throw new Error("An explicit isolated .t3 destination is required");
  const isWithin = (parent: string, child: string) => {
    const relative = NodePath.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${NodePath.sep}`) &&
        !NodePath.isAbsolute(relative))
    );
  };
  const base = NodeFS.realpathSync(destination);
  // Compare canonical paths so a symlinked home or .t3 cannot alias the live profile.
  const livePath = NodePath.join(NodeOS.homedir(), ".t3");
  const live = NodeFS.existsSync(livePath)
    ? NodeFS.realpathSync(livePath)
    : NodePath.join(NodeFS.realpathSync(NodeOS.homedir()), ".t3");
  if (NodePath.basename(base) !== ".t3" || isWithin(live, base))
    throw new Error("Refusing non-isolated home");
  const database = NodeFS.realpathSync(NodePath.join(base, "userdata/statev2.sqlite"));
  if (database === base || !isWithin(base, database))
    throw new Error("Refusing database symlink outside isolated home");
  if (mode === "seed") {
    const runtime = NodePath.join(base, "userdata/server-runtime.json");
    if (NodeFS.existsSync(runtime)) {
      const record = JSON.parse(NodeFS.readFileSync(runtime, "utf8"));
      if (typeof record.pid !== "number") throw new Error("Unrecognized server ownership record");
      try {
        process.kill(record.pid, 0);
        throw new Error("Server is still running; stop its retained session before seeding");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  }
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: mode === "assert" });
  const childProjection = buildChildFixture();
  Schema.decodeUnknownSync(OrchestrationV2ThreadProjectionJson)(childProjection);
  const groups = [
    ["threads", [projection.thread, childProjection.thread], "thread_id"],
    ["runs", projection.runs, "run_id"],
    ["provider_threads", projection.providerThreads, "provider_thread_id"],
    ["turn_items", projection.turnItems, "turn_item_id"],
  ] as const;
  const indexedValue = (column: string, row: Record<string, unknown>, idColumn: string) => {
    if (column === idColumn) return row.id;
    if (column === "thread_id") return row.threadId ?? row.appThreadId;
    if (column === "default_provider" || column === "provider") return row.providerInstanceId;
    const camel = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return row[camel];
  };
  try {
    if (mode === "seed") {
      db.exec("BEGIN IMMEDIATE");
      for (const [suffix] of groups.toReversed()) {
        const table = `orchestration_v2_projection_${suffix}`;
        const key = "thread_id";
        for (const id of [projection.thread.id, childProjection.thread.id]) {
          db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(id);
        }
      }
      db.prepare("DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ?").run(
        projection.thread.id,
      );
      db.prepare(`INSERT OR REPLACE INTO projection_projects
        (project_id,title,workspace_root,scripts_json,created_at,updated_at,deleted_at)
        VALUES (?,?,?,?,?,?,NULL)`).run(
        projection.thread.projectId,
        "Synthetic evidence",
        NodePath.resolve(base, ".."),
        "[]",
        timestamp,
        timestamp,
      );
      for (const [suffix, rows, idColumn] of groups) {
        const table = `orchestration_v2_projection_${suffix}`;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        for (const row of rows) {
          const values = new Map<string, string | number | null>();
          for (const column of columns) {
            const name = String(column.name);
            const value =
              name === "payload_json" ? JSON.stringify(row) : indexedValue(name, row, idColumn);
            if (value === undefined) {
              if (column.notnull && column.dflt_value === null)
                throw new Error(`Missing indexed field ${table}.${name}`);
              continue;
            }
            if (
              value !== null &&
              typeof value !== "string" &&
              typeof value !== "number" &&
              typeof value !== "boolean"
            )
              throw new Error(`Unexpected indexed field ${name}`);
            values.set(name, typeof value === "boolean" ? Number(value) : value);
          }
          db.prepare(
            `INSERT INTO ${table} (${[...values.keys()].join(",")}) VALUES (${[...values].map(() => "?").join(",")})`,
          ).run(...values.values());
        }
      }
      for (const item of projection.turnItems) {
        db.prepare(
          "INSERT INTO orchestration_v2_turn_item_positions (thread_id,turn_item_id,ordinal) VALUES (?,?,?)",
        ).run(item.threadId, item.id, item.ordinal);
      }
      db.exec("COMMIT");
    }
    for (const [suffix, rows, idColumn] of groups) {
      for (const row of rows) {
        const stored = db
          .prepare(`SELECT * FROM orchestration_v2_projection_${suffix} WHERE ${idColumn} = ?`)
          .get(row.id);
        if (!stored || stored.payload_json !== JSON.stringify(row))
          throw new Error(`Projection changed: ${suffix} ${row.id}`);
        for (const [column, value] of Object.entries(stored)) {
          if (column === "payload_json") continue;
          const expected = indexedValue(column, row, idColumn);
          if (
            expected !== undefined &&
            value !== expected &&
            !(typeof expected === "boolean" && value === Number(expected))
          )
            throw new Error(`Index mismatch: ${suffix}.${column}`);
        }
      }
    }
  } finally {
    db.close();
  }
}
console.log(
  JSON.stringify(
    {
      fixture,
      phase,
      namespace,
      fixtureNames,
      checksum,
      timestamp,
      threadId: projection.thread.id,
      projectId: projection.thread.projectId,
      route: "/<environmentId>/" + encodeURIComponent(projection.thread.id),
      mode,
      schemaValid: true,
      captureVerified: false,
      limitations: [
        "No provider execution",
        "Browser mode overrides client projection atoms and holds Stop transport",
        "Stop acceptance and task removal are separate milestones",
        "Startup recovery must pass assert before capture",
      ],
    },
    null,
    2,
  ),
);

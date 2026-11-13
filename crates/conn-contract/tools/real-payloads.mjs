// Reads real records from a statev2.sqlite (read-only), keeps those the TS schema decodes, and
// writes them canonically re-encoded: real-payloads.mjs <db> <out.json> [perTable], then
// CONN_CONTRACT_REAL_PAYLOADS=<out.json> cargo test -p conn-contract --test round_trip.
// The output holds user data: keep it under target/ and never commit it.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";

import { inMonorepo } from "../../../tools/monorepo.mjs";

const [dbPath, outPath, perTableArg] = process.argv.slice(2);
if (!dbPath || !outPath) {
  console.error("usage: real-payloads.mjs <statev2.sqlite> <out.json> [perTable]");
  process.exit(2);
}
const perTable = Number(perTableArg ?? 2000);

const contractsDir = inMonorepo("packages/contracts");
const resolve = NodeModule.createRequire(NodePath.join(contractsDir, "package.json")).resolve;
const { Schema } = await import(NodeURL.pathToFileURL(resolve("effect")).href);
const C = await import(NodeURL.pathToFileURL(NodePath.join(contractsDir, "src/index.ts")).href);

// Projection table -> the contract schema its payload_json holds.
const TABLES = {
  threads: "OrchestrationV2AppThread",
  runs: "OrchestrationV2Run",
  nodes: "OrchestrationV2ExecutionNode",
  provider_sessions: "OrchestrationV2ProviderSession",
  provider_threads: "OrchestrationV2ProviderThread",
  provider_turns: "OrchestrationV2ProviderTurn",
  runtime_requests: "OrchestrationV2RuntimeRequest",
  messages: "OrchestrationV2ConversationMessage",
  plans: "OrchestrationV2PlanArtifact",
  turn_items: "OrchestrationV2TurnItem",
  subagents: "OrchestrationV2Subagent",
};

const dropUndefined = (v) => {
  if (Array.isArray(v)) return v.map(dropUndefined);
  if (v === null || typeof v !== "object" || v instanceof Date) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null && !Object.values(v).includes(undefined))
    return v;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  for (const k of Reflect.ownKeys(descriptors)) {
    const d = descriptors[k];
    if ("value" in d) {
      if (d.value === undefined && d.enumerable) delete descriptors[k];
      else d.value = dropUndefined(d.value);
    }
  }
  return Object.create(proto, descriptors);
};

const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
const out = [];
const stats = {};
for (const [table, schemaName] of Object.entries(TABLES)) {
  const schema = C[schemaName];
  if (!schema) throw new Error(`${schemaName} is not exported`);
  const codec = Schema.toCodecJson(schema);
  const decode = Schema.decodeUnknownSync(codec);
  const encode = Schema.encodeSync(codec);
  // Newest rows first: they use the current shapes. Spread over `type` where the table has one.
  const hasType = db
    .prepare(
      `SELECT 1 FROM pragma_table_info('orchestration_v2_projection_${table}') WHERE name = 'type'`,
    )
    .get();
  const rows = hasType
    ? db
        .prepare(
          `SELECT payload_json FROM (SELECT payload_json, ROW_NUMBER() OVER (PARTITION BY type ORDER BY rowid DESC) AS n
             FROM orchestration_v2_projection_${table}) WHERE n <= ?`,
        )
        .all(Math.max(20, Math.ceil(perTable / 20)))
    : db
        .prepare(
          `SELECT payload_json FROM orchestration_v2_projection_${table} ORDER BY rowid DESC LIMIT ?`,
        )
        .all(perTable);
  const s = (stats[table] = { rows: rows.length, decoded: 0, rejectedByTs: 0 });
  for (const { payload_json } of rows) {
    let value;
    try {
      value = decode(JSON.parse(payload_json));
    } catch {
      s.rejectedByTs++;
      continue;
    }
    out.push({ key: schemaName, value: JSON.parse(JSON.stringify(encode(dropUndefined(value)))) });
    s.decoded++;
  }
}
db.close();
NodeFS.writeFileSync(outPath, JSON.stringify(out));
console.log(JSON.stringify(stats));
console.log(`${out.length} payloads -> ${outPath}`);

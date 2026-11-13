#!/usr/bin/env node
// Checks the tables this repository keeps by hand against the Conn monorepo, where a generator
// would be more churn than the table: the auth scope lists in crates/conn-server/src/auth.rs and
// the wire constants in crates/conn-wire/src/lib.rs. Fails with each difference.
//
//   CONN_MONOREPO=<conn checkout> node tools/check-copies.mjs
//
// The Rust side is read from the source text, so a renamed constant fails here too.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { importSource, inMonorepo, repoRoot } from "./monorepo.mjs";

const failures = [];
const same = (label, ours, theirs) => {
  const a = JSON.stringify(ours);
  const b = JSON.stringify(theirs);
  if (a === b) console.log(`ok   ${label}`);
  else failures.push(`${label}: ours ${a}, upstream ${b}`);
};
const rust = (rel) => NodeFS.readFileSync(NodePath.join(repoRoot, rel), "utf8");
const ts = (rel) => NodeFS.readFileSync(inMonorepo(rel), "utf8");
/** The string literals of `const NAME: &[&str] = &[...]` (or `= OTHER`, followed once). */
function rustStrings(text, name) {
  const m = new RegExp(`const ${name}: &\\[&str\\] = (&\\[([\\s\\S]*?)\\]|(\\w+));`).exec(text);
  if (!m) throw new Error(`no const ${name}`);
  if (m[3]) return rustStrings(text, m[3]);
  return [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}
/** `const NAME: usize = <expr>;` evaluated (digits, `*` and `_`). */
function rustNumber(text, name) {
  const m = new RegExp(`const ${name}: usize = ([0-9_ *]+);`).exec(text);
  if (!m) throw new Error(`no const ${name}`);
  return Function(`return ${m[1].replaceAll("_", "")};`)();
}
/** `const NAME = <number expr>;` in TypeScript. */
function tsNumber(text, name) {
  const m = new RegExp(`const ${name} = ([0-9_ *]+);`).exec(text);
  if (!m) throw new Error(`no const ${name} upstream`);
  return Function(`return ${m[1].replaceAll("_", "")};`)();
}
/**
 * The members of `const NAME ... = new Set([...])` in TypeScript: string literals, and
 * constants (`AuthOrchestrationReadScope`, `WS_METHODS.subscribeServerConfig`) looked up in
 * `scope`, the upstream modules' exports.
 */
function tsSet(text, name, scope) {
  const m = new RegExp(`const ${name}[^=]*= new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`).exec(text);
  if (!m) throw new Error(`no Set ${name} upstream`);
  return m[1]
    .split(",")
    .map((item) => item.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
    .map((item) => {
      const literal = /^"([^"]*)"$/.exec(item);
      if (literal) return literal[1];
      // An exported constant, else a module-private `const X = "..."` in the same file.
      const value =
        item.split(".").reduce((object, key) => object?.[key], scope) ??
        new RegExp(`const ${item}\\b[^=]*= "([^"]*)"`).exec(text)?.[1];
      if (typeof value !== "string") throw new Error(`${name}: cannot resolve ${item}`);
      return value;
    });
}
const sorted = (list) => [...list].sort();

// ---- Auth scopes (packages/contracts/src/auth.ts) ----------------------------------------
const auth = await importSource("packages/contracts/src/auth.ts");
const authRs = rust("crates/conn-server/src/auth.rs");
same("auth.rs STANDARD_SCOPES = AuthStandardClientScopes", rustStrings(authRs, "STANDARD_SCOPES"), [
  ...auth.AuthStandardClientScopes,
]);
if (!auth.AuthGrantScope?.literals?.length) failures.push("AuthGrantScope has no literals upstream");
same(
  "auth.rs GRANT_SCOPES = AuthGrantScope literals",
  sorted(rustStrings(authRs, "GRANT_SCOPES")),
  sorted(auth.AuthGrantScope?.literals ?? []),
);
const authTs = ts("packages/contracts/src/auth.ts");
same("auth.rs LEGACY_SCOPES = legacyScopes", sorted(rustStrings(authRs, "LEGACY_SCOPES")), sorted(tsSet(authTs, "legacyScopes", auth)));
// legacy_parent: compare its match arms with `authScopeRequiredResponse` for every scope.
const environmentScopes = auth.AuthEnvironmentScope?.literals ?? [];
const body = /pub fn legacy_parent\(scope: &str\) -> &str \{([\s\S]*?)\n\}/.exec(authRs)?.[1] ?? "";
const parents = {};
for (const arm of body.matchAll(/((?:"[^"]+"\s*\|?\s*)+)=>\s*"([^"]+)"/g)) {
  for (const scope of arm[1].matchAll(/"([^"]+)"/g)) parents[scope[1]] = arm[2];
}
if (environmentScopes.length === 0) failures.push("AuthEnvironmentScope has no literals upstream");
same(
  "auth.rs legacy_parent = authScopeRequiredResponse",
  Object.fromEntries(environmentScopes.map((s) => [s, parents[s] ?? s])),
  Object.fromEntries(environmentScopes.map((s) => [s, auth.authScopeRequiredResponse(s).requiredScope])),
);

// ---- Wire (packages/shared/src/socketFrameParts.ts, terminal/OutputProtocol.ts) -----------
const wireRs = rust("crates/conn-wire/src/lib.rs");
const frames = ts("packages/shared/src/socketFrameParts.ts");
same("conn-wire PART_BYTES = SOCKET_FRAME_PART_BYTES", rustNumber(wireRs, "PART_BYTES"), tsNumber(frames, "SOCKET_FRAME_PART_BYTES"));
same(
  "conn-wire QUERY_PARAM = SOCKET_FRAME_PARTS_QUERY_PARAM",
  /const QUERY_PARAM: &str = "([^"]*)";/.exec(wireRs)?.[1],
  /export const SOCKET_FRAME_PARTS_QUERY_PARAM = "([^"]*)";/.exec(frames)?.[1],
);
same(
  "conn-wire PART_PREFIX = PART_PREFIX",
  /const PART_PREFIX: char = '\\u\{([0-9a-f]+)\}';/.exec(wireRs)?.[1]?.padStart(4, "0"),
  /const PART_PREFIX = "\\u([0-9a-f]{4})";/.exec(frames)?.[1],
);
const output = ts("apps/server/src/terminal/OutputProtocol.ts");
const methods = {
  WS_METHODS: (await importSource("packages/contracts/src/rpc.ts")).WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS: (await importSource("packages/contracts/src/orchestrationV2.ts")).ORCHESTRATION_V2_WS_METHODS,
};
same("ack_window MAX_PENDING_CHUNKS", rustNumber(wireRs, "MAX_PENDING_CHUNKS"), tsNumber(output, "MAX_PENDING_CHUNKS"));
same("ack_window MAX_PENDING_BYTES", rustNumber(wireRs, "MAX_PENDING_BYTES"), tsNumber(output, "MAX_PENDING_BYTES"));
same("ack_window VALUE_OVERHEAD_BYTES = EVENT_OVERHEAD", rustNumber(wireRs, "VALUE_OVERHEAD_BYTES"), tsNumber(output, "EVENT_OVERHEAD"));
same("ack_window COUNT_WINDOWED", sorted(rustStrings(wireRs, "COUNT_WINDOWED")), sorted(tsSet(output, "COUNT_WINDOWED_STREAMS", methods)));
same("ack_window BYTE_WINDOWED", sorted(rustStrings(wireRs, "BYTE_WINDOWED")), sorted(tsSet(output, "BYTE_WINDOWED_STREAMS", methods)));

for (const failure of failures) console.log(`FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
else console.log("hand-kept copies match the Conn monorepo");

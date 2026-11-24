#!/usr/bin/env node
// Checks the tables this repository keeps by hand against the Conn monorepo, where a generator
// would be more churn than the table: the auth scope lists in crates/conn-server/src/auth.rs and
// the wire constants in crates/conn-wire/src/lib.rs, and the Claude launch lists in
// crates/conn-provider-claude/src/launch.rs. Fails with each difference.
//
//   node tools/check-copies.mjs
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

// ---- Claude launch lists (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) ------
/** The string literals of `export const NAME ... = [ ... ]` in TypeScript. */
function tsStrings(text, name) {
  const m = new RegExp(`const ${name}\\b[^=]*= \\[([\\s\\S]*?)\\]`).exec(text);
  if (!m) throw new Error(`no array ${name} upstream`);
  return [...m[1].replace(/\/\/.*$/gm, "").matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}
const launchRs = rust("crates/conn-provider-claude/src/launch.rs");
const claudeTs = ts("apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts");
same(
  "launch.rs READ_ONLY_TOOLS = CLAUDE_READ_ONLY_ALLOWED_TOOLS",
  rustStrings(launchRs, "READ_ONLY_TOOLS"),
  tsStrings(claudeTs, "CLAUDE_READ_ONLY_ALLOWED_TOOLS"),
);
same(
  "launch.rs READ_ONLY_T3_MCP_TOOLS = CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS",
  rustStrings(launchRs, "READ_ONLY_T3_MCP_TOOLS"),
  tsStrings(claudeTs, "CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS"),
);
same(
  "launch.rs T3_MCP_WILDCARD = CLAUDE_T3_MCP_TOOL_WILDCARD",
  /const T3_MCP_WILDCARD: &str = "([^"]*)";/.exec(launchRs)?.[1],
  /export const CLAUDE_T3_MCP_TOOL_WILDCARD = "([^"]*)";/.exec(claudeTs)?.[1],
);

// ---- Codex texts the Codex provider shows as they are ------------------------------------------
{
  const codexRs = rust("crates/conn-provider-codex/src/session.rs");
  const codexTs = ts("apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts");
  same(
    "conn-provider-codex CODEX_THREAD_IN_USE_MESSAGE = CodexAdapterV2's",
    /const CODEX_THREAD_IN_USE_MESSAGE: &str = "([^"]*)";/.exec(codexRs)?.[1],
    /const CODEX_THREAD_IN_USE_MESSAGE =\s*"([^"]*)";/.exec(codexTs)?.[1],
  );
}

// ---- Antigravity's texts for a failed explicit model refresh ----------------------------------
{
  const agyRs = rust("crates/conn-provider-acp/src/antigravity_provider.rs");
  const agyTs = ts("apps/server/src/provider/Drivers/AntigravityDriver.ts");
  const rustText = (name) => new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(agyRs)?.[1];
  same(
    "antigravity_provider.rs REFRESH_FAILED = AntigravityDriver's",
    rustText("REFRESH_FAILED"),
    /const REFRESH_FAILED =\s*"([^"]*)";/.exec(agyTs)?.[1],
  );
  same(
    "antigravity_provider.rs REFRESH_TIMED_OUT = AntigravityDriver's timeout detail",
    rustText("REFRESH_TIMED_OUT"),
    /detail: "(Antigravity model refresh timed out[^"]*)"/.exec(agyTs)?.[1],
  );
  same(
    "antigravity_provider.rs REFRESH_SIGN_IN = AntigravityDriver's sign-in detail",
    rustText("REFRESH_SIGN_IN"),
    /\? "(Sign in to Antigravity in provider settings[^"]*)"/.exec(agyTs)?.[1],
  );
  const agyStateRs = rust("crates/conn-provider-acp/src/antigravity.rs");
  const stateText = (name) =>
    new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(agyStateRs)?.[1];
  same(
    "antigravity.rs PYTHON_SOCKS_REQUIRED = AntigravityDriver's",
    stateText("PYTHON_SOCKS_REQUIRED"),
    /const PYTHON_SOCKS_REQUIRED = "([^"]*)";/.exec(agyTs)?.[1],
  );
  same(
    "antigravity.rs SIGN_IN_MESSAGE = AntigravityProvider's",
    stateText("SIGN_IN_MESSAGE"),
    /const SIGN_IN_MESSAGE = "([^"]*)";/.exec(ts("apps/server/src/provider/AntigravityProvider.ts"))?.[1],
  );
  const authTs = ts("apps/server/src/provider/antigravityAuthSupport.ts");
  same(
    "antigravity.rs AUTH_STDOUT_PREFIX = ANTIGRAVITY_AUTH_STDOUT_PREFIX",
    stateText("AUTH_STDOUT_PREFIX"),
    /ANTIGRAVITY_AUTH_STDOUT_PREFIX =\s*"([^"]*)";/.exec(authTs)?.[1],
  );
  same(
    "antigravity.rs SIGN_IN_REQUIRED_MESSAGE = ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE",
    stateText("SIGN_IN_REQUIRED_MESSAGE"),
    /ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE =\s*"([^"]*)";/.exec(authTs)?.[1],
  );
  same(
    "antigravity.rs INVALID_AUTH_URL = parseAntigravityAuthorizationUrl's",
    stateText("INVALID_AUTH_URL"),
    /authSupportError\("(Antigravity returned an invalid Google sign-in URL\.)"\)/.exec(authTs)?.[1],
  );
  same(
    "antigravity.rs MAX_AUTH_URL = maxAuthorizationUrlLength",
    /const MAX_AUTH_URL: usize = ([\d_]+);/.exec(agyStateRs)?.[1]?.replaceAll("_", ""),
    /const maxAuthorizationUrlLength = ([\d_]+);/.exec(authTs)?.[1]?.replaceAll("_", ""),
  );
  same(
    "server.rs USAGE_LIMITS_COMMAND = @t3tools/shared USAGE_LIMITS_COMMAND",
    /const USAGE_LIMITS_COMMAND: \(&str, &str\) =\s*\("([^"]*)",\s*"([^"]*)"\);/.exec(rust("crates/conn-server/src/methods/server.rs"))?.slice(1).join("|"),
    /USAGE_LIMITS_COMMAND = \{\s*name: "([^"]*)",\s*description: "([^"]*)",/.exec(ts("packages/shared/src/usageLimits.ts"))?.slice(1).join("|"),
  );
  same(
    "antigravity.rs NO_BROWSER_PREFIX = antigravityAuthSupport's",
    stateText("NO_BROWSER_PREFIX"),
    /const NATIVE_CLI_NO_BROWSER_PREFIX = "([^"]*)";/.exec(ts("apps/server/src/provider/antigravityAuthSupport.ts"))?.[1],
  );
  // The server's own setup errors, which the credential check shows as they are.
  const driverTexts = [
    ["crates/conn-provider-acp/src/antigravity_provider.rs", ["SETUP_WORKSPACE_FAILED", "RUNTIME_TEMP_FAILED"]],
    ["crates/conn-provider-acp/src/antigravity.rs", ["CUSTOM_EXECUTABLE_MISSING", "EXECUTABLE_MISSING"]],
  ];
  for (const [file, names] of driverTexts) {
    const source = rust(file);
    for (const name of names) {
      const ours = new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1];
      same(`${NodePath.basename(file)} ${name} is a text of AntigravityDriver.ts`, ours !== undefined && agyTs.includes(`"${ours}"`), true);
    }
  }
}

// ---- Antigravity's profile texts (apps/server/src/provider/antigravityAuthSupport.ts) --------
{
  const supportTs = ts("apps/server/src/provider/antigravityAuthSupport.ts");
  const source = rust("crates/conn-provider-acp/src/antigravity.rs");
  for (const name of ["PROFILE_DIRECTORY_FAILED", "PROFILE_PERMISSIONS_FAILED", "PROFILE_SETTINGS_FAILED"]) {
    const ours = new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1];
    same(`antigravity.rs ${name} is a text of antigravityAuthSupport.ts`, ours !== undefined && supportTs.includes(`"${ours}"`), true);
  }
}

// ---- Antigravity's credential check (apps/server/src/provider/AntigravityAuth.ts) -----------
{
  const authTs = ts("apps/server/src/provider/AntigravityAuth.ts");
  const texts = [
    ["crates/conn-server/src/methods/provider_auth.rs", ["CHECKING", "VERIFYING", "CONNECTED",
      "IN_PROGRESS", "NOT_ACTIVE", "EXPIRED", "CANCELLED", "NO_LINK_YET", "OTHER_CLIENT",
      "CHECK_FAILED", "NOT_STARTED", "NOT_RESPONDING", "NO_RESPONSE", "UNREACHABLE"]],
    ["crates/conn-provider-acp/src/antigravity_provider.rs", ["CREDENTIALS_FAILED",
      "SUBSCRIPTION_REQUIRED", "NOT_APPROVED", "NO_SESSION", "REJECTED"]],
  ];
  for (const [file, names] of texts) {
    const source = rust(file);
    for (const name of names) {
      const ours = new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1];
      same(`${NodePath.basename(file)} ${name} is a text of AntigravityAuth.ts`, ours !== undefined && authTs.includes(`"${ours}"`), true);
    }
  }
}

// ---- The Codex status probe's tables (apps/server/src/provider/CodexProvider.ts) ---------------
{
  const statusRs = rust("crates/conn-provider-codex/src/status.rs");
  const providerTs = ts("apps/server/src/provider/CodexProvider.ts");
  /** `"a" | "b" => "Label"` arms of a Rust `fn NAME` match, as {a: Label, b: Label}. */
  const rustArms = (name) => {
    const fnBody = new RegExp(`fn ${name}\\b[\\s\\S]*?\\n\\}`).exec(statusRs)?.[0] ?? "";
    const out = {};
    for (const arm of fnBody.matchAll(/((?:"[^"]+"\s*\|?\s*)+)=>\s*\{?\s*"([^"]+)"/g)) {
      for (const key of arm[1].matchAll(/"([^"]+)"/g)) out[key[1]] = arm[2];
    }
    return out;
  };
  // `codexPlanLabel`: `case "a": case "b": return "Label";`.
  const planBody = /export function codexPlanLabel[\s\S]*?\n\}/.exec(providerTs)?.[0] ?? "";
  const plans = {};
  let cases = [];
  for (const m of planBody.matchAll(/case "([^"]+)":|return "([^"]+)";/g)) {
    if (m[1]) cases.push(m[1]);
    else {
      for (const c of cases) plans[c] = m[2];
      cases = [];
    }
  }
  same("status.rs plan_label = codexPlanLabel", rustArms("plan_label"), plans);
  const effortTs = /const REASONING_EFFORT_LABELS[^=]*= \{([\s\S]*?)\};/.exec(providerTs)?.[1] ?? "";
  same(
    "status.rs effort_label = REASONING_EFFORT_LABELS",
    rustArms("effort_label"),
    Object.fromEntries([...effortTs.matchAll(/(\w+): "([^"]+)"/g)].map((m) => [m[1], m[2]])),
  );
  const contracts = await importSource("packages/contracts/src/model.ts");
  same(
    "status.rs PREFERRED_DEFAULT_MODELS = PREFERRED_DEFAULT_CODEX_MODELS",
    [...(/const PREFERRED_DEFAULT_MODELS: \[&str; \d+\] = \[([^\]]*)\]/.exec(statusRs)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    [...contracts.PREFERRED_DEFAULT_CODEX_MODELS],
  );
}

// ---- The Claude Agent SDK version (AGENTS.md: the same SDK version as the T3 server) ----------
// T3 pins a range in apps/server/package.json; its pnpm lockfile holds the version it runs.
const t3Sdk = [...ts("pnpm-lock.yaml").matchAll(/\n {2}'?@anthropic-ai\/claude-agent-sdk@([0-9][^':(]*)'?:/g)].map(
  (m) => m[1],
);
const hostLock = JSON.parse(rust("helpers/sdk-host/package-lock.json"));
same(
  "helpers/sdk-host claude-agent-sdk = the T3 server's locked version",
  [
    JSON.parse(rust("helpers/sdk-host/package.json")).dependencies?.["@anthropic-ai/claude-agent-sdk"],
    hostLock.packages?.["node_modules/@anthropic-ai/claude-agent-sdk"]?.version,
  ],
  [...new Set(t3Sdk)].length === 1 ? [t3Sdk[0], t3Sdk[0]] : [`one version in pnpm-lock.yaml, found ${t3Sdk.join(", ")}`],
);

for (const failure of failures) console.log(`FAIL ${failure}`);
if (failures.length > 0) process.exitCode = 1;
else console.log("hand-kept copies match the Conn monorepo");

#!/usr/bin/env node
// Conformance check for Grok's status probe: does conn-provider-acp probe the Grok CLI and
// build the `ServerProvider` entry exactly as the T3 server does?
//
//   CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/probe-conformance.mjs [--keep] [--verbose] [scenario ...]
//
// No real CLI runs and no model is called. Each scenario gives a stub `grok`
// (tools/grok-cli-stub.mjs) a behaviour: a missing or broken CLI, one that hangs, an old one
// without `models` or ACP, a logged-out one, a healthy one. Both sides probe it:
//
// 1. T3: one temporary vitest file in packages/provider-grok/src/server runs T3's own
//    `checkGrokProviderStatus` for every scenario at once, with the instance's environment
//    merged as `mergeProviderInstanceEnvironment` does and the result stamped with
//    `withInstanceIdentity`, as the driver does. The file is deleted afterwards. A run
//    refuses to start while another run's file is there.
// 2. Rust: `cargo run --example grok_probe` runs our probe for the same scenarios.
// 3. Compared: the entry (`checkedAt` aside), and per CLI run the argv, the environment the
//    child got (relative to its parent's), its working folder (as <server> or <workspace>),
//    every stdin line (trace ids aside), and the signals it saw, in order.
//
// Any difference exits 1.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo, repoRoot } from "../../../tools/monorepo.mjs";

const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const STUB = NodePath.join(HERE, "grok-cli-stub.mjs");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const verbose = args.includes("--verbose");
const only = args.filter((a) => !a.startsWith("--"));

const LOGGED_IN = "You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n";
const LOGGED_OUT = LOGGED_IN.replace("You are logged in with grok.com.", "You are not authenticated.");
const SKILLS = JSON.stringify({
  skills: [
    { name: "deploy", description: " Ship it ", source: { path: "/skills/deploy/SKILL.md", type: "project" } },
    { name: "audit", userInvocable: false, source: { path: "/skills/audit/SKILL.md" } },
    { name: "", source: { path: "/x" } },
  ],
});
const INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  _meta: {
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            reasoningEffort: "high",
            reasoningEfforts: [
              { value: "high", label: "High", default: true },
              { value: "low", label: "Low", description: "Faster" },
              { value: "medium", label: "Medium" },
            ],
          },
        },
        { modelId: "grok-4.5", name: " ", _meta: { supportsReasoningEffort: false } },
        { modelId: "grok-4.5", name: "Duplicate" },
      ],
    },
    availableCommands: [
      { name: "compact", description: "Compress history", input: { hint: "what to preserve" } },
      { name: "always-approve", description: "Skip prompts" },
      { name: "context", description: "Context" },
      { name: "deep-research", description: "Research a topic", input: { hint: "<query>" } },
      { name: "broken", description: 42 },
    ],
  },
};
const ok = (stdout) => ({ code: 0, stdout });
const healthy = {
  version: ok("grok 1.0.52\n"),
  models: [ok(LOGGED_IN)],
  inspect: ok(SKILLS),
  agent: { mode: "ok", initialize: INITIALIZE },
};

// `instance` is the `providerInstances.grok` entry; `binary` is "stub" (the wrapper),
// "missing" (no file) or "not-executable" (a file without the execute bit).
const SCENARIOS = [
  { name: "disabled", instance: { driver: "grok" }, binary: "stub", behaviour: healthy },
  { name: "missing-cli", instance: { driver: "grok", enabled: true }, binary: "missing", behaviour: {} },
  { name: "not-executable", instance: { driver: "grok", enabled: true }, binary: "not-executable", behaviour: {} },
  {
    name: "version-hangs",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: { version: { hang: true, ignoreTerm: true } },
  },
  {
    name: "version-fails",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: { version: { code: 1, stdout: "grok 1.2.3\n", stderr: "boom\n" } },
  },
  {
    name: "old-cli",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: {
      version: ok("grok version 0.9.1\n"),
      models: [{ code: 2, stderr: "error: unknown command 'models'\n  * not-a-model\n" }],
      inspect: { code: 2, stderr: "error: unknown command 'inspect'\n" },
      agent: { mode: "exit", code: 2 },
    },
  },
  { name: "ready", instance: { driver: "grok", enabled: true }, binary: "stub", behaviour: healthy },
  {
    name: "logged-out",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: { ...healthy, models: [ok(LOGGED_OUT)] },
  },
  {
    name: "token-refreshed",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: { ...healthy, models: [ok(LOGGED_OUT), ok(LOGGED_IN)] },
  },
  {
    name: "api-key",
    instance: {
      driver: "grok",
      enabled: true,
      environment: [{ name: "XAI_API_KEY", value: "stub-not-a-key", sensitive: true }, { name: "GROK_EXTRA", value: "1" }],
    },
    binary: "stub",
    behaviour: { ...healthy, models: [ok(LOGGED_OUT)] },
  },
  {
    name: "acp-hangs",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: { ...healthy, agent: { mode: "hang", ignoreTerm: true } },
  },
  {
    name: "acp-error",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: { ...healthy, agent: { mode: "error" } },
  },
  {
    name: "models-hang-no-skills",
    instance: { driver: "grok", enabled: true },
    binary: "stub",
    behaviour: { ...healthy, models: [{ hang: true }], inspect: ok("not json") },
  },
  {
    name: "custom-models",
    instance: {
      driver: "grok",
      enabled: true,
      displayName: "My Grok",
      accentColor: "#ff0000",
      config: { customModels: ["my-model", { slug: "grok-4.6", name: "Renamed" }, " my-model "] },
    },
    binary: "stub",
    behaviour: { ...healthy, agent: { mode: "ok", initialize: { protocolVersion: 1 } } },
  },
].filter((s) => only.length === 0 || only.includes(s.name));

const work = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-grok-probe-")));

const binaryFor = (scenario, side) => {
  const dir = NodePath.join(work, scenario.name, side);
  NodeFS.mkdirSync(dir, { recursive: true });
  if (scenario.binary === "missing") return NodePath.join(dir, "no-such-grok");
  const script = NodePath.join(dir, "grok");
  if (scenario.binary === "not-executable") {
    NodeFS.writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    return script;
  }
  const config = NodePath.join(dir, "stub-config.json");
  NodeFS.writeFileSync(config, JSON.stringify({ behaviour: scenario.behaviour, log: NodePath.join(dir, "stub.ndjson") }));
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} --stub-config ${JSON.stringify(config)} "$@"\n`,
    { mode: 0o755 },
  );
  return script;
};

const plan = SCENARIOS.map((scenario) => {
  const dir = NodePath.join(work, scenario.name);
  const workspace = NodePath.join(dir, "workspace");
  NodeFS.mkdirSync(workspace, { recursive: true });
  const withBinary = (binary) => ({
    ...scenario.instance,
    config: { ...scenario.instance.config, binaryPath: binary },
  });
  return {
    name: scenario.name,
    dir,
    workspace,
    tsInstance: withBinary(binaryFor(scenario, "ts")),
    rustInstance: withBinary(binaryFor(scenario, "rust")),
    tsOut: NodePath.join(dir, "ts-entry.json"),
    rustOut: NodePath.join(dir, "rust-entry.json"),
  };
});

// ---- T3 side ------------------------------------------------------------------------------

const TEST_SOURCE = `
import * as fs from "node:fs";
import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { resolveProviderInstanceEnabled } from "@t3tools/contracts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import { GrokSettings } from "../settings.ts";
import { checkGrokProviderStatus } from "./status.ts";

const PLAN = __PLAN__;
fs.writeFileSync(__PARENT_ENV__, JSON.stringify(process.env));
fs.writeFileSync(__SERVER_CWD__, process.cwd());

// Live clock: the probe's timeouts must really pass.
it.live("conn grok probe: every scenario", () =>
    Effect.forEach(
      PLAN,
      (scenario: any) =>
        Effect.gen(function* () {
          const instance = scenario.tsInstance;
          const enabled = resolveProviderInstanceEnabled(instance);
          const settings = { ...Schema.decodeSync(GrokSettings)(instance.config ?? {}), enabled };
          const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
          const draft = yield* checkGrokProviderStatus(settings, environment, scenario.workspace);
          const entry = withInstanceIdentity({
            instanceId: "grok" as any,
            driverKind: "grok" as any,
            displayName: instance.displayName,
            accentColor: instance.accentColor,
            continuationGroupKey: defaultProviderContinuationIdentity({ driverKind: "grok" as any, instanceId: "grok" as any }).continuationKey,
          })(draft);
          fs.writeFileSync(scenario.tsOut, JSON.stringify({ ...entry, checkedAt: "<checkedAt>" }, null, 2));
        }),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))), 120_000);
`;

const pkg = NodePath.join(MONOREPO, "packages/provider-grok");
// The name carries this run's PID, so runs side by side on one checkout do not collide.
const testFile = NodePath.join(pkg, "src/server", `ConnGrokProbe.${process.pid}.tmp.test.ts`);
const tsParentEnv = NodePath.join(work, "ts-parent-env.json");
const tsServerCwd = NodePath.join(work, "ts-server-cwd.txt");
NodeFS.writeFileSync(
  testFile,
  TEST_SOURCE.replace("__PLAN__", JSON.stringify(plan))
    .replace("__PARENT_ENV__", JSON.stringify(tsParentEnv))
    .replace("__SERVER_CWD__", JSON.stringify(tsServerCwd)),
);
try {
  NodeChildProcess.execFileSync("vp", ["test", "run", "--config", "../../vite.config.ts", NodePath.relative(pkg, testFile)], {
    cwd: pkg,
    stdio: ["ignore", verbose ? "inherit" : "ignore", "inherit"],
  });
} catch {
  // Missing T3 entries are reported per scenario below.
} finally {
  NodeFS.rmSync(testFile, { force: true });
}

// ---- Rust side ----------------------------------------------------------------------------

const planFile = NodePath.join(work, "plan.json");
const rustParentEnv = NodePath.join(work, "rust-parent-env.json");
const rustServerCwd = NodePath.join(work, "rust-server-cwd.txt");
NodeFS.writeFileSync(planFile, JSON.stringify({ scenarios: plan, parentEnv: rustParentEnv, serverCwd: rustServerCwd }));
NodeChildProcess.execFileSync(
  "cargo",
  ["run", "--quiet", "-p", "conn-provider-acp", "--example", "grok_probe", "--", planFile],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);

// ---- compare ------------------------------------------------------------------------------

const readLog = (file) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const readJson = (file) => (NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : undefined);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).toSorted().map((k) => [k, canonical(value[k])]))
      : value;
const envDelta = (env, parent) =>
  Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => parent[k] !== v)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
const scrubTrace = (line) =>
  line.replace(/"traceId":"[0-9a-f]{32}"/g, '"traceId":"<trace>"').replace(/"spanId":"[0-9a-f]{16}"/g, '"spanId":"<span>"');
const sides = {
  ts: { parent: JSON.parse(NodeFS.readFileSync(tsParentEnv, "utf8")), cwd: NodeFS.readFileSync(tsServerCwd, "utf8") },
  rust: { parent: JSON.parse(NodeFS.readFileSync(rustParentEnv, "utf8")), cwd: NodeFS.readFileSync(rustServerCwd, "utf8") },
};
const binaryDir = (scenario, side) => NodePath.join(scenario.dir, side);

// One record per CLI run: argv, environment delta, folder, then its stdin lines and signals.
const runs = (scenario, side) => {
  const log = readLog(NodePath.join(binaryDir(scenario, side), "stub.ndjson"));
  const dir = binaryDir(scenario, side);
  const byStart = [];
  for (const entry of log) {
    if (entry.kind === "start") {
      const cwd = entry.cwd === sides[side].cwd ? "<server>" : entry.cwd === scenario.workspace ? "<workspace>" : entry.cwd;
      const delta = envDelta(entry.env, sides[side].parent);
      // The /bin/sh wrapper sets PWD to its folder when the inherited one names another.
      if (delta.PWD === entry.cwd) delete delta.PWD;
      const env = JSON.parse(JSON.stringify(delta).replaceAll(dir, "<bin>"));
      byStart.push({ argv: entry.argv, env, cwd, events: [] });
    } else {
      const run = entry.argv
        ? byStart.findLast((r) => JSON.stringify(r.argv) === JSON.stringify(entry.argv))
        : byStart.findLast((r) => r.argv.includes("agent"));
      run?.events.push(entry.kind === "stdin" ? `stdin ${scrubTrace(entry.line)}` : `${entry.kind}${entry.signal ? ` ${entry.signal}` : ""}`);
    }
  }
  // T3's scope ends the agent's stdin a moment before its SIGKILL; whether the stub logs that
  // in time is a race on T3's own side, so a last "stdin-closed" is not compared.
  for (const run of byStart) {
    if (run.events.at(-1) === "stdin-closed") run.events.pop();
  }
  return byStart;
};

let differences = 0;
const report = [];
for (const scenario of plan) {
  const problems = [];
  const ts = readJson(scenario.tsOut);
  const rust = readJson(scenario.rustOut);
  if (ts === undefined) problems.push("the T3 side wrote no entry");
  if (rust === undefined) problems.push("the Rust side wrote no entry");
  if (ts && rust) {
    const [a, b] = [JSON.stringify(canonical(ts)), JSON.stringify(canonical(rust))];
    if (a !== b) problems.push(`entry:\n    T3   ${a}\n    Rust ${b}`);
  }
  const [tsRuns, rustRuns] = [runs(scenario, "ts"), runs(scenario, "rust")];
  if (tsRuns.length !== rustRuns.length) {
    problems.push(`CLI runs: T3 ${tsRuns.map((r) => r.argv.join(" ")).join(" | ")}; Rust ${rustRuns.map((r) => r.argv.join(" ")).join(" | ")}`);
  }
  for (let i = 0; i < Math.min(tsRuns.length, rustRuns.length); i += 1) {
    const [a, b] = [JSON.stringify(tsRuns[i]), JSON.stringify(rustRuns[i])];
    if (a !== b) problems.push(`run ${i}:\n    T3   ${a.slice(0, 1500)}\n    Rust ${b.slice(0, 1500)}`);
  }
  if (problems.length > 0) {
    differences += 1;
    report.push(`DIFF ${scenario.name}\n  ${problems.join("\n  ")}`);
  } else {
    report.push(`same ${scenario.name} (${ts.status}; ${tsRuns.length} CLI run${tsRuns.length === 1 ? "" : "s"})`);
  }
}
console.log(report.join("\n"));
console.log(`\n${plan.length - differences} of ${plan.length} probe scenarios the same.`);
if (!keep) NodeFS.rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
process.exit(differences === 0 ? 0 : 1);

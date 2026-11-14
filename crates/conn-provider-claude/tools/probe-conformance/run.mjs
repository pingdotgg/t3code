#!/usr/bin/env node
// Conformance check for Claude's status probe: does conn-provider-claude probe the `claude`
// CLI and build the `ServerProvider` entry exactly as the T3 server does?
//
//   CONN_MONOREPO=/path/to/conn node crates/conn-provider-claude/tools/probe-conformance/run.mjs [--keep] [scenario ...]
//
// No real CLI runs and no model is called. Each scenario gives a stub `claude`
// (stub-claude.mjs) a behaviour: missing, failing or hanging on `--version`, an old version,
// signed out, signed in with usage windows, an API key, a failed initialization, disabled.
// Both sides probe it:
//
// 1. T3: one temporary vitest file in apps/server/src/provider runs T3's own
//    `checkClaudeProviderStatus` with `probeClaudeCapabilities` (the official SDK, in
//    process), with the environment `mergeClaudeProcessEnvironment` builds and the entry
//    stamped by `withInstanceIdentity`, as `ClaudeDriver` does. The file is deleted after.
// 2. Ours: `cargo run --example claude_probe`: `status::check` with this checkout's SDK
//    host.
// 3. Compared: the entry (`checkedAt` stamps aside), and per CLI run the argv, the
//    environment the child got beyond its parent's, its working folder, every stdin line
//    (request ids aside) and the signals it saw, in order.
//
// Any difference exits 1.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo, repoRoot } from "../../../../tools/monorepo.mjs";
import { sealedNodeEnv } from "../../../../tools/sealed-env.mjs";

const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const STUB = NodePath.join(HERE, "stub-claude.mjs");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = args.filter((a) => !a.startsWith("--"));

const ok = (version) => ({ stdout: `${version} (Claude Code)\n`, code: 0 });
const COMMANDS = [
  { name: "review", description: "Review a pull request", argumentHint: "<pr>" },
  { name: "Review", description: "dupe", argumentHint: "" },
  { name: "compact", description: "Claude's own compact", argumentHint: "[focus]" },
  { name: " ", description: "blank" },
];
const MODELS = [
  { value: "default", displayName: "Default", description: "" },
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "" },
  { value: "gateway-model-x", displayName: " Gateway X ", description: "", supportsEffort: true, supportedEffortLevels: ["low", "xhigh"] },
];
const signedIn = (account, extra = {}) => ({
  version: ok("2.1.300"),
  init: { commands: COMMANDS, models: MODELS, account, output_style: "default", available_output_styles: [] },
  usage: {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12.5, resets_at: "2026-11-14T15:00:00Z" },
      seven_day: { utilization: 130, resets_at: null },
      model_scoped: [{ display_name: "Opus 5.5", utilization: 3, resets_at: "2026-11-20T00:00:00.000Z" }],
      extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 0, utilization: 0 },
    },
  },
  settings: { effective: {} },
  ...extra,
});
const PRO = { email: "probe@example.com", subscriptionType: "pro", tokenSource: "claude.ai", apiKeySource: "none" };

const SCENARIOS = [
  { name: "disabled", instance: { driver: "claudeAgent", enabled: false }, binary: "stub", behaviour: signedIn(PRO) },
  { name: "missing-cli", instance: { driver: "claudeAgent" }, binary: "missing", behaviour: {} },
  { name: "version-fails", instance: { driver: "claudeAgent" }, binary: "stub", behaviour: { version: { code: 1, stdout: "2.1.300\n", stderr: "boom\n" } } },
  { name: "version-hangs", instance: { driver: "claudeAgent" }, binary: "stub", behaviour: { version: { hang: true } } },
  { name: "old-cli", instance: { driver: "claudeAgent" }, binary: "stub", behaviour: { ...signedIn(PRO), version: ok("2.1.200") } },
  { name: "signed-in", instance: { driver: "claudeAgent" }, binary: "stub", behaviour: signedIn(PRO) },
  {
    name: "signed-out",
    instance: { driver: "claudeAgent" },
    binary: "stub",
    behaviour: signedIn({ tokenSource: "none", apiKeySource: "none" }, { usage: "error" }),
  },
  {
    name: "signed-out-home",
    instance: { driver: "claudeAgent", config: { homePath: "<home>/claude-home" } },
    binary: "stub",
    behaviour: signedIn({ tokenSource: "none" }, { usage: "error" }),
  },
  {
    name: "api-key",
    instance: { driver: "claudeAgent", environment: [{ name: "CLAUDE_EXTRA", value: "1" }] },
    binary: "stub",
    behaviour: signedIn({ tokenSource: "ANTHROPIC_API_KEY", apiKeySource: "ANTHROPIC_API_KEY" }, { usage: { rate_limits_available: false } }),
  },
  { name: "init-fails", instance: { driver: "claudeAgent" }, binary: "stub", behaviour: { ...signedIn(PRO), init: "error" } },
].filter((s) => only.length === 0 || only.includes(s.name));

const work = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-claude-probe-")));
const home = NodePath.join(work, "home");
NodeFS.mkdirSync(home, { recursive: true });
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };

const binaryFor = (scenario, side) => {
  const dir = NodePath.join(work, scenario.name, side);
  NodeFS.mkdirSync(dir, { recursive: true });
  if (scenario.binary === "missing") return NodePath.join(dir, "no-such-claude");
  NodeFS.writeFileSync(NodePath.join(dir, "behaviour.json"), JSON.stringify(scenario.behaviour));
  const script = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(NodePath.join(dir, "stub-claude.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.copyFileSync(STUB, NodePath.join(dir, "stub-claude.mjs"));
  return script;
};

const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll("<home>", home));
const plan = SCENARIOS.map((scenario) => {
  const dir = NodePath.join(work, scenario.name);
  const cwd = NodePath.join(dir, "state");
  NodeFS.mkdirSync(cwd, { recursive: true });
  const withBinary = (binary) => {
    const instance = fill(scenario.instance);
    return { ...instance, config: { ...instance.config, binaryPath: binary } };
  };
  return {
    name: scenario.name,
    dir,
    cwd,
    tsInstance: withBinary(binaryFor(scenario, "ts")),
    rustInstance: withBinary(binaryFor(scenario, "rust")),
    tsOut: NodePath.join(dir, "ts-entry.json"),
  };
});

// ---- T3 ----
const TEST_SOURCE = `
import * as fs from "node:fs";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClaudeSettings, resolveProviderInstanceEnabled } from "@t3tools/contracts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { checkClaudeProviderStatus, probeClaudeCapabilities } from "./ClaudeProvider.ts";
import { makeClaudeContinuationGroupKey, mergeClaudeProcessEnvironment } from "./Drivers/ClaudeHome.ts";

const PLAN = __PLAN__;
const BASE_ENV = __BASE_ENV__;
fs.writeFileSync(__PARENT_ENV__, JSON.stringify(process.env));

it.live("conn claude probe: every scenario", () =>
  Effect.forEach(
    PLAN,
    (scenario: any) =>
      Effect.gen(function* () {
        const instance = scenario.tsInstance;
        const enabled = resolveProviderInstanceEnabled(instance);
        const settings = { ...Schema.decodeSync(ClaudeSettings)(instance.config ?? {}), enabled };
        const processEnv = yield* mergeClaudeProcessEnvironment(settings, instance.environment, BASE_ENV);
        const draft = yield* checkClaudeProviderStatus(
          settings,
          (s: any) => probeClaudeCapabilities(s, processEnv, scenario.cwd),
          processEnv,
          scenario.cwd,
        );
        const entry = withInstanceIdentity({
          instanceId: "claudeAgent" as any,
          driverKind: "claudeAgent" as any,
          displayName: instance.displayName,
          accentColor: instance.accentColor,
          continuationGroupKey: yield* makeClaudeContinuationGroupKey(settings, processEnv),
        })(draft);
        fs.writeFileSync(scenario.tsOut, JSON.stringify(entry, null, 2));
      }),
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.provide(NodeServices.layer)), 180_000);
`;
const server = NodePath.join(MONOREPO, "apps/server");
const testFile = NodePath.join(server, "src/provider", `ConnClaudeProbe.${process.pid}.tmp.test.ts`);
const tsParentEnv = NodePath.join(work, "ts-parent-env.json");
NodeFS.writeFileSync(
  testFile,
  TEST_SOURCE.replace("__PLAN__", JSON.stringify(plan))
    .replace("__BASE_ENV__", JSON.stringify(BASE_ENV))
    .replace("__PARENT_ENV__", JSON.stringify(tsParentEnv)),
);
const cleanup = () => NodeFS.rmSync(testFile, { force: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}
try {
  NodeChildProcess.execFileSync(
    process.execPath,
    [NodePath.join(MONOREPO, "node_modules/vite-plus/bin/vp"), "test", "run", NodePath.relative(server, testFile)],
    {
      cwd: server,
      stdio: ["ignore", "ignore", "inherit"],
      // Sealed: T3 finds Claude's home with os.homedir(), so the run gets the throwaway HOME
      // and no variable of the shell beyond what node needs (no ANTHROPIC_*, no CLAUDE_*).
      env: { ...sealedNodeEnv(work), HOME: home },
    },
  );
} catch {
  // A failed T3 run leaves entries missing; the comparison reports them.
} finally {
  cleanup();
}

// ---- Ours ----
const planFile = NodePath.join(work, "plan.json");
const rustOut = NodePath.join(work, "rust-entries.json");
NodeFS.writeFileSync(
  planFile,
  JSON.stringify({
    baseEnv: BASE_ENV,
    scenarios: plan.map((p) => ({ name: p.name, instance: p.rustInstance, cwd: p.cwd })),
  }),
);
const build = NodeChildProcess.spawnSync("cargo", ["build", "--quiet", "-p", "conn-provider-claude", "--example", "claude_probe"], {
  cwd: repoRoot,
  stdio: ["ignore", "inherit", "inherit"],
});
if (build.status !== 0) {
  console.error("probe-conformance: claude_probe did not build");
  process.exit(1);
}
const targetDir = process.env.CARGO_TARGET_DIR ? NodePath.resolve(repoRoot, process.env.CARGO_TARGET_DIR) : NodePath.join(repoRoot, "target");
// The example runs with a known environment, so its SDK host's is known too.
const rustParent = { ...BASE_ENV };
NodeChildProcess.spawnSync(NodePath.join(targetDir, "debug/examples/claude_probe"), [planFile, rustOut], {
  cwd: repoRoot,
  env: rustParent,
  stdio: ["ignore", "inherit", "inherit"],
});

// ---- Compare ----
const readJson = (file) => (NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : undefined);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).toSorted().map((k) => [k, canonical(value[k])]))
      : value;
const stripStamps = (entry, side, scenario) => {
  if (entry === undefined) return undefined;
  const text = JSON.stringify(entry).replaceAll(NodePath.join(scenario.dir, side), "<stub>");
  const copy = JSON.parse(text);
  copy.checkedAt = "<checkedAt>";
  if (copy.usageLimits) copy.usageLimits.checkedAt = "<checkedAt>";
  return canonical(copy);
};
const envDelta = (env, parent) =>
  Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => parent[k] !== v)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
const scrub = (value, scenario, side) => {
  let text = JSON.stringify(value).replaceAll(NodePath.join(scenario.dir, side), "<stub>");
  text = text.replace(/"request_id":"[^"]*"/g, '"request_id":"<id>"');
  return JSON.parse(text);
};
const runs = (scenario, side, parent) => {
  const dir = NodePath.join(scenario.dir, side, "records");
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .toSorted()
    .map((f) => readJson(NodePath.join(dir, f)))
    .map((r) => scrub({ argv: r.argv, env: r.env, cwd: r.cwd, stdin: r.stdin, signals: r.signals }, scenario, side));
};

const tsParent = readJson(tsParentEnv) ?? {};
const ours = readJson(rustOut) ?? {};
let differ = 0;
for (const scenario of plan) {
  const t3 = stripStamps(readJson(scenario.tsOut), "ts", scenario);
  const conn = stripStamps(ours[scenario.name], "rust", scenario);
  const problems = [];
  if (t3 === undefined) problems.push("T3 wrote no entry");
  if (conn === undefined) problems.push("ours wrote no entry");
  if (t3 !== undefined && conn !== undefined && JSON.stringify(t3) !== JSON.stringify(conn)) {
    problems.push(`entry differs:\n    t3:   ${JSON.stringify(t3)}\n    conn: ${JSON.stringify(conn)}`);
  }
  const t3Runs = runs(scenario, "ts", tsParent);
  const connRuns = runs(scenario, "rust", rustParent);
  if (t3Runs.length !== connRuns.length) problems.push(`CLI runs: t3 ${t3Runs.length}, conn ${connRuns.length}`);
  for (let i = 0; i < Math.min(t3Runs.length, connRuns.length); i++) {
    for (const key of ["argv", "env", "cwd", "stdin", "signals"]) {
      const a = JSON.stringify(canonical(t3Runs[i][key]));
      const b = JSON.stringify(canonical(connRuns[i][key]));
      if (a !== b) problems.push(`run ${i} ${key} differs:\n    t3:   ${a}\n    conn: ${b}`);
    }
  }
  if (problems.length === 0) {
    console.log(`SAME ${scenario.name} (${t3Runs.length} CLI run(s), status ${t3?.status})`);
  } else {
    differ += 1;
    console.log(`DIFF ${scenario.name}\n  ${problems.join("\n  ")}`);
  }
}
if (!keep && differ === 0) NodeFS.rmSync(work, { recursive: true, force: true });
else console.log(`work folder: ${work}`);
console.log(differ === 0 ? "No differences." : `${differ} scenario(s) differ.`);
process.exit(differ === 0 ? 0 : 1);

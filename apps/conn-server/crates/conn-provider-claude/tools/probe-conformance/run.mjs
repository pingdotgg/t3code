#!/usr/bin/env node
// Conformance check for Claude's status probe: does conn-provider-claude probe the `claude`
// CLI and build the `ServerProvider` entry exactly as the T3 server does?
//
//   node crates/conn-provider-claude/tools/probe-conformance/run.mjs [--keep] [scenario ...]
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

import { exampleBinary } from "../../../../tools/check-binaries.mjs";
import { monorepo, repoRoot } from "../../../../tools/monorepo.mjs";
import { canaryEnv, sealedNodeEnv } from "../../../../tools/sealed-env.mjs";
import { GUARD_IMPORT } from "../../../../tools/no-outside-fetch.mjs";

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
  // Thread titles through Claude (`ClaudeTextGeneration.ts`): the CLI with `-p`, the prompt on
  // stdin. T3 runs its own `generateThreadTitle`; ours gets T3's prompt and schema and runs
  // `ClaudeProvider::generate_text`.
  {
    name: "title",
    instance: { driver: "claudeAgent" },
    binary: "stub",
    title: { message: "Fix the login redirect after a password reset", modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5" } },
    behaviour: { title: [{ code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { title: "Login Redirect After Reset", needsRefinement: false } }) }] },
  },
  {
    name: "title-options",
    instance: { driver: "claudeAgent", environment: [{ name: "CLAUDE_EXTRA", value: "1" }] },
    binary: "stub",
    title: {
      message: "Why does the build cache miss on CI?",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "opus",
        options: [{ id: "effort", value: "high" }, { id: "fastMode", value: true }, { id: "ultracode", value: false }],
      },
    },
    behaviour: { title: [{ code: 0, stdout: JSON.stringify([{ type: "system" }, { type: "result", structured_output: { title: "CI Build Cache Misses", needsRefinement: false } }]) }] },
  },
  {
    name: "title-old-cli",
    instance: { driver: "claudeAgent", config: { homePath: "<home>/claude-home" } },
    binary: "stub",
    title: { message: "Add dark mode", modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" } },
    behaviour: {
      title: [
        { code: 1, stderr: "error: unknown option '--no-session-persistence'\n" },
        { code: 0, stdout: JSON.stringify({ structured_output: { title: "Dark Mode", needsRefinement: false } }) },
      ],
    },
  },
  {
    name: "title-error",
    instance: { driver: "claudeAgent" },
    binary: "stub",
    title: { message: "Add dark mode", modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" } },
    behaviour: { title: [{ code: 1, stdout: JSON.stringify({ is_error: true, result: "Credit balance is too low" }), stderr: "wrapper notice\n" }] },
  },
  // An instance as Orbit writes one: a `~` binary path (made relative to the throwaway HOME
  // below), a sensitive variable, `CLAUDE_CONFIG_DIR` with `~`, a display name and accent.
  {
    name: "instance-settings",
    instance: {
      driver: "claudeAgent",
      displayName: " Claude Max ",
      accentColor: "#aa5500",
      environment: [
        { name: "CONFORMANCE_SENSITIVE", value: "conformance-sensitive-value", sensitive: true },
        { name: "CLAUDE_CONFIG_DIR", value: "~/env-claude-home" },
      ],
    },
    binary: "stub",
    tilde: true,
    behaviour: signedIn(PRO),
  },
  {
    name: "title-instance",
    instance: {
      driver: "claudeAgent",
      config: { homePath: "~/claude-home" },
      environment: [{ name: "CONFORMANCE_SENSITIVE", value: "conformance-sensitive-value", sensitive: true }],
    },
    binary: "stub",
    tilde: true,
    title: { message: "Add dark mode", modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" } },
    behaviour: { title: [{ code: 0, stdout: JSON.stringify({ structured_output: { title: "Dark Mode", needsRefinement: false } }) }] },
  },
].filter((s) => only.length === 0 || only.includes(s.name));

const work = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-claude-probe-")));
const home = NodePath.join(work, "home");
NodeFS.mkdirSync(home, { recursive: true });
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: NodeOS.tmpdir(), ...canaryEnv() };

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
    // `tilde`: the stub named from the throwaway HOME, as `~/../<scenario>/<side>/claude`.
    const binaryPath = scenario.tilde ? `~/${NodePath.relative(home, binary)}` : binary;
    return { ...instance, config: { ...instance.config, binaryPath } };
  };
  return {
    name: scenario.name,
    dir,
    cwd,
    tsInstance: withBinary(binaryFor(scenario, "ts")),
    rustInstance: withBinary(binaryFor(scenario, "rust")),
    tsOut: NodePath.join(dir, "ts-entry.json"),
    title: scenario.title ?? null,
  };
});

// ---- T3 ----
const TEST_SOURCE = `
import * as fs from "node:fs";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClaudeSettings, ProviderInstanceConfig, resolveProviderInstanceEnabled } from "@t3tools/contracts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { checkClaudeProviderStatus, probeClaudeCapabilities } from "./ClaudeProvider.ts";
import { makeClaudeTextGeneration } from "../textGeneration/ClaudeTextGeneration.ts";
import { buildThreadTitlePrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Exit from "effect/Exit";
import { makeClaudeContinuationGroupKey, mergeClaudeProcessEnvironment } from "./Drivers/ClaudeHome.ts";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";

const PLAN = __PLAN__;
const BASE_ENV = __BASE_ENV__;
fs.writeFileSync(__PARENT_ENV__, JSON.stringify(process.env));

it.live("conn claude probe: every scenario", () =>
  Effect.forEach(
    PLAN,
    (scenario: any) =>
      Effect.gen(function* () {
        // As the registry reads it: decoded (display name and accent trimmed).
        const instance = Schema.decodeUnknownSync(ProviderInstanceConfig)(scenario.tsInstance);
        const enabled = resolveProviderInstanceEnabled(instance);
        // As the Claude driver builds its effective settings: binaryPath with \`~\` expanded.
        const decoded = Schema.decodeSync(ClaudeSettings)(instance.config ?? {});
        const settings = { ...decoded, enabled, binaryPath: expandHomePath(decoded.binaryPath, BASE_ENV.HOME) };
        const processEnv = yield* mergeClaudeProcessEnvironment(settings, instance.environment, BASE_ENV);
        if (scenario.title !== null) {
          // What ours gets: T3's own prompt and output schema for this message.
          const built = buildThreadTitlePrompt({ message: scenario.title.message });
          const request = { prompt: built.prompt, outputSchema: JSON.stringify(toJsonSchemaObject(built.outputSchema)) };
          const generation = yield* makeClaudeTextGeneration(settings, processEnv);
          const exit = yield* Effect.scoped(
            generation.generateThreadTitle({
              cwd: scenario.cwd,
              message: scenario.title.message,
              modelSelection: scenario.title.modelSelection,
            }),
          ).pipe(Effect.exit);
          fs.writeFileSync(
            scenario.tsOut,
            JSON.stringify({
              request,
              ok: Exit.isSuccess(exit),
              title: Exit.isSuccess(exit) ? exit.value.title : null,
              failure: Exit.isSuccess(exit) ? null : String((exit.cause as any)?.reasons?.[0]?.error?.detail ?? exit.cause),
            }),
          );
          return;
        }
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
  ).pipe(
    Effect.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "conn-claude-probe-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ), 180_000);
`;
const server = NodePath.join(MONOREPO, "apps/server");
const testFile = NodePath.join(server, "src/provider", `ConnClaudeProbe.${process.pid}.tmp.test.ts`);
const tsParentEnv = NodePath.join(work, "ts-parent-env.json");
NodeFS.writeFileSync(
  testFile,
  GUARD_IMPORT +
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
    scenarios: plan.map((p) => ({ name: p.name, instance: p.rustInstance, cwd: p.cwd, title: p.title, tsOut: p.tsOut })),
  }),
);
const binary = exampleBinary("conn-provider-claude", "claude_probe");
// The example runs with a known environment, so its SDK host's is known too.
const rustParent = { ...BASE_ENV };
NodeChildProcess.spawnSync(binary, [planFile, rustOut], {
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
  text = text.replace(/t3code-claude-title-[A-Za-z0-9]+/g, "t3code-claude-title-<rand>");
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
  const titleOf = (value) => (value === undefined ? undefined : canonical({ ok: value.ok, title: value.title, failure: value.failure }));
  const t3 = scenario.title !== null ? titleOf(readJson(scenario.tsOut)) : stripStamps(readJson(scenario.tsOut), "ts", scenario);
  const conn = scenario.title !== null ? titleOf(ours[scenario.name]) : stripStamps(ours[scenario.name], "rust", scenario);
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
    console.log(`SAME ${scenario.name} (${t3Runs.length} CLI run(s), ${scenario.title !== null ? `title ${t3?.ok ? JSON.stringify(t3.title) : `failed: ${t3?.failure}`}` : `status ${t3?.status}`})`);
  } else {
    differ += 1;
    console.log(`DIFF ${scenario.name}\n  ${problems.join("\n  ")}`);
  }
}
if (!keep && differ === 0) NodeFS.rmSync(work, { recursive: true, force: true });
else console.log(`work folder: ${work}`);
console.log(differ === 0 ? "No differences." : `${differ} scenario(s) differ.`);
process.exit(differ === 0 ? 0 : 1);

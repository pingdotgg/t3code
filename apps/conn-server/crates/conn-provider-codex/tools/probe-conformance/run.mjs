#!/usr/bin/env node
// Conformance check for Codex's status probe: does conn-provider-codex probe `codex
// app-server` and build the `ServerProvider` entry exactly as the T3 server does?
//
//   node crates/conn-provider-codex/tools/probe-conformance/run.mjs [--keep] [scenario ...]
//
// No real CLI runs and no model is called. Each scenario gives a stub `codex`
// (stub-codex.mjs) a behaviour: missing, an old CLI without app-server, hanging, failing,
// signed out, signed in with ChatGPT (with and without Codex's model cache refresh), an API
// key, Orbit's AI router, failing reads, disabled. Both sides probe it:
//
// 1. T3: one temporary vitest file in apps/server/src/provider runs T3's own
//    `checkCodexProviderStatus` with the settings, environment and home layout `CodexDriver`
//    builds, then `applyCodexModelCatalog` with the bundled manifest and
//    `withInstanceIdentity`, as `CodexDriver` does. The file is deleted after.
// 2. Ours: `cargo run --example codex_probe`: `status::check` with the same environment.
// 3. Compared: the entry (`checkedAt` stamps aside), and per CLI run the argv, the
//    environment, the working folder (each side's server folder as `<server>`), every stdin
//    line (request ids aside; the concurrent reads after `account/read` grouped by method) and
//    how the run ended (end of input, signals), in order.
//
// Sealed: T3's side runs with `sealedNodeEnv` and a throwaway HOME, imports the fetch guard,
// and both sides probe with PATH=/usr/bin:/bin, which holds no provider CLI (checked).
// Any difference exits 1.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { exampleBinary } from "../../../../tools/check-binaries.mjs";
import { monorepo, repoRoot } from "../../../../tools/monorepo.mjs";
import { sealedNodeEnv } from "../../../../tools/sealed-env.mjs";
import { GUARD_IMPORT } from "../../../../tools/no-outside-fetch.mjs";

const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const STUB = NodePath.join(HERE, "stub-codex.mjs");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = args.filter((a) => !a.startsWith("--"));
const SAFE_PATH = "/usr/bin:/bin";
for (const dir of SAFE_PATH.split(":")) {
  for (const cli of ["codex", "claude", "grok"]) {
    if (NodeFS.existsSync(NodePath.join(dir, cli))) {
      console.error(`probe-conformance: ${dir}/${cli} exists; the sealed PATH must hold no provider CLI`);
      process.exit(1);
    }
  }
}

const efforts = ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: "" }));
const model = (slug, displayName, extra = {}) => ({
  id: slug,
  model: slug,
  displayName,
  description: "",
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: efforts,
  ...extra,
});
const PAGE_1 = {
  data: [
    model("gpt-6.1-sol", "gpt-6.1-sol", { isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }, { id: "ultrafast", name: "Ultrafast", description: "" }] }),
    model("gpt-6-astra", "GPT-6-Astra", { additionalSpeedTiers: ["fast"], availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] } }),
  ],
  nextCursor: "page-2",
};
const PAGE_2 = {
  data: [model("gpt-6-sol", "gpt-6-sol", { defaultServiceTier: "flex", serviceTiers: [{ id: "flex", name: "Flex", description: "Cheaper" }] })],
  nextCursor: null,
};
const SKILLS = {
  data: [
    { cwd: "/elsewhere", errors: [], skills: [{ name: "other", description: "", enabled: true, path: "/skills/other/SKILL.md", scope: "repo" }] },
    {
      cwd: "<cwd>",
      errors: [],
      skills: [
        { name: "review", description: "Review code", enabled: true, path: "/skills/review/SKILL.md", scope: "user", interface: { displayName: "Review", shortDescription: "Reviews" } },
        { name: "plain", description: "", enabled: false, path: "/skills/plain/SKILL.md", scope: "system", shortDescription: "Short" },
      ],
    },
  ],
};
const RATE_LIMITS = {
  accountId: " ws-123 ",
  rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: 42, resetsAt: 1_900_000_000, windowDurationMins: 300 }, secondary: { usedPercent: 130, resetsAt: null } },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: { availableCount: 2, credits: [
    { id: "c1", grantedAt: 1_800_000_000, resetType: "codexRateLimits", status: "available", expiresAt: 1_900_100_000 },
    { id: "c2", grantedAt: 1_800_000_000, resetType: "codexRateLimits", status: "redeemed", expiresAt: 1_800_000_000 },
  ] },
};
const CHATGPT = { account: { type: "chatgpt", email: "probe@example.com", planType: "plus" }, requiresOpenaiAuth: true };
const NATIVE_CONFIG = { config: { service_tier: "fast", daybreak: true }, origins: {} };
const signedIn = (extra = {}) => ({
  version: { code: 0, stdout: "codex-cli 0.166.0\n" },
  account: CHATGPT,
  skills: SKILLS,
  models: [PAGE_1, PAGE_2],
  config: NATIVE_CONFIG,
  rateLimits: RATE_LIMITS,
  refreshCache: true,
  ...extra,
});

const SCENARIOS = [
  { name: "disabled", instance: { driver: "codex", enabled: false, config: { customModels: ["my-model"] } }, binary: "stub", behaviour: signedIn() },
  { name: "missing-cli", instance: { driver: "codex" }, binary: "missing", behaviour: {} },
  { name: "missing-on-path", instance: { driver: "codex", config: { binaryPath: "codex" } }, binary: "bare", behaviour: {} },
  { name: "hangs", instance: { driver: "codex" }, binary: "stub", behaviour: { hang: true, version: { code: 0, stdout: "codex-cli 0.166.0\n" } } },
  { name: "init-fails", instance: { driver: "codex" }, binary: "stub", behaviour: { ...signedIn(), init: "error", version: { code: 1, stdout: "codex-cli 0.166.0\n" } } },
  {
    name: "signed-out-home",
    instance: { driver: "codex", config: { homePath: "<home>/codex-signed-out" } },
    binary: "stub",
    behaviour: { ...signedIn(), account: { account: null, requiresOpenaiAuth: true } },
  },
  { name: "signed-out", instance: { driver: "codex" }, binary: "stub", behaviour: { ...signedIn(), account: { requiresOpenaiAuth: true } } },
  { name: "chatgpt", instance: { driver: "codex", config: { homePath: "<home>/codex-chatgpt" } }, binary: "stub", behaviour: signedIn() },
  {
    name: "chatgpt-no-refresh",
    instance: { driver: "codex", config: { homePath: "<home>/codex-stale" } },
    binary: "stub",
    behaviour: signedIn({ refreshCache: false, models: [{ ...PAGE_2, nextCursor: null }] }),
  },
  {
    name: "api-key",
    instance: { driver: "codex", config: { customModels: ["my-model", { slug: "gpt-6-astra", name: "Astra (mine)" }, { slug: "typed", name: " Typed ", capabilities: { optionDescriptors: [] } }] } },
    binary: "stub",
    behaviour: signedIn({
      account: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      config: { config: { features: { api_key_cyber_access_programs: false } }, origins: {} },
    }),
  },
  {
    // Orbit's container: Codex reaches models through the AI router; no sign-in.
    name: "orbit-router",
    instance: { driver: "codex" },
    binary: "stub",
    behaviour: signedIn({
      account: { account: null, requiresOpenaiAuth: false },
      config: { config: { model_provider: "orbit", model_providers: { orbit: { base_url: "http://router.orbit:8080/v1" } } }, origins: {} },
      models: [{ data: [model("gpt-6-luna", "gpt-6-luna")], nextCursor: null }],
    }),
  },
  { name: "skills-fail", instance: { driver: "codex" }, binary: "stub", behaviour: signedIn({ account: { account: { type: "apiKey" }, requiresOpenaiAuth: true }, skills: "error" }) },
  { name: "models-hang", instance: { driver: "codex" }, binary: "stub", behaviour: signedIn({ account: { account: { type: "apiKey" }, requiresOpenaiAuth: true }, models: "hang" }) },
  { name: "usage-fails", instance: { driver: "codex", config: { homePath: "<home>/codex-usage" } }, binary: "stub", behaviour: signedIn({ rateLimits: "error" }) },
  {
    // An instance as Orbit writes one: a `~` binary path, launch arguments from the
    // instance's environment, a sensitive variable, a display name and accent.
    name: "instance-settings",
    instance: {
      driver: "codex",
      displayName: " Codex Work ",
      accentColor: "#335577",
      config: { launchArgs: "--ignored-setting", homePath: "~/codex-work" },
      environment: [
        { name: "CONFORMANCE_SENSITIVE", value: "conformance-sensitive-value", sensitive: true },
        { name: "T3CODE_CODEX_LAUNCH_ARGS", value: "-c model_verbosity=low" },
      ],
    },
    binary: "stub",
    tilde: true,
    behaviour: signedIn({ account: { account: { type: "amazonBedrock" }, requiresOpenaiAuth: false }, config: { config: {}, origins: {} } }),
  },
].filter((s) => only.length === 0 || only.includes(s.name));

const work = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-codex-probe-")));
const home = NodePath.join(work, "home");
NodeFS.mkdirSync(home, { recursive: true });

const binaryFor = (scenario, side) => {
  const dir = NodePath.join(work, scenario.name, side);
  NodeFS.mkdirSync(dir, { recursive: true });
  if (scenario.binary === "missing") return NodePath.join(dir, "no-such-codex");
  if (scenario.binary === "bare") return "codex";
  NodeFS.writeFileSync(NodePath.join(dir, "behaviour.json"), JSON.stringify(scenario.behaviour));
  const script = NodePath.join(dir, "codex");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(NodePath.join(dir, "stub-codex.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.copyFileSync(STUB, NodePath.join(dir, "stub-codex.mjs"));
  return script;
};

const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll("<home>", home));
const plan = SCENARIOS.map((scenario) => {
  const dir = NodePath.join(work, scenario.name);
  const withBinary = (binary) => {
    const instance = fill(scenario.instance);
    if (scenario.binary === "bare") return instance;
    const binaryPath = scenario.tilde ? `~/${NodePath.relative(home, binary)}` : binary;
    return { ...instance, config: { ...instance.config, binaryPath } };
  };
  return {
    name: scenario.name,
    dir,
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
import { CodexSettings, ProviderInstanceConfig, resolveProviderInstanceEnabled } from "@t3tools/contracts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { checkCodexProviderStatus } from "./CodexProvider.ts";
import { applyCodexModelCatalog } from "./codexModelCatalog.ts";
import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";
import { codexContinuationIdentity, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

const PLAN = __PLAN__;
// The server's environment, with a PATH that holds no provider CLI.
const BASE = { ...process.env, PATH: __SAFE_PATH__ };
fs.writeFileSync(__BASE_OUT__, JSON.stringify(BASE));
fs.writeFileSync(__CWD_OUT__, process.cwd());

it.live("conn codex probe: every scenario", () =>
  Effect.forEach(
    PLAN,
    (scenario: any) =>
      Effect.gen(function* () {
        // As \`CodexDriver.create\` builds it.
        const instance = Schema.decodeUnknownSync(ProviderInstanceConfig)(scenario.tsInstance);
        const enabled = resolveProviderInstanceEnabled(instance);
        const config = Schema.decodeSync(CodexSettings)(instance.config ?? {});
        const processEnv = yield* mergeProviderInstanceEnvironment(instance.environment, BASE);
        const environmentHome = processEnv.CODEX_HOME;
        const homeConfig = !config.homePath.trim() && environmentHome?.trim() ? { ...config, homePath: environmentHome } : config;
        const layout = yield* resolveCodexHomeLayout(homeConfig);
        const effectiveConfig = {
          ...config,
          enabled,
          binaryPath: expandHomePath(config.binaryPath, BASE.HOME),
          homePath: layout.effectiveHomePath ?? "",
        };
        const draft = yield* checkCodexProviderStatus(effectiveConfig, undefined, processEnv);
        const catalog = resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, "codex" as any, Date.now()) ?? undefined;
        const entry = withInstanceIdentity({
          instanceId: "codex" as any,
          driverKind: "codex" as any,
          displayName: instance.displayName,
          accentColor: instance.accentColor,
          continuationGroupKey: codexContinuationIdentity(layout).continuationKey,
        })(applyCodexModelCatalog(draft, catalog));
        fs.writeFileSync(scenario.tsOut, JSON.stringify(entry, null, 2));
      }),
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.provide(NodeServices.layer)), 180_000);
`;
const server = NodePath.join(MONOREPO, "apps/server");
const testFile = NodePath.join(server, "src/provider", `ConnCodexProbe.${process.pid}.tmp.test.ts`);
const baseOut = NodePath.join(work, "base-env.json");
const tsCwdOut = NodePath.join(work, "ts-server-cwd.txt");
NodeFS.writeFileSync(
  testFile,
  GUARD_IMPORT +
    TEST_SOURCE.replace("__PLAN__", JSON.stringify(plan))
      .replace("__SAFE_PATH__", JSON.stringify(SAFE_PATH))
      .replace("__BASE_OUT__", JSON.stringify(baseOut))
      .replace("__CWD_OUT__", JSON.stringify(tsCwdOut)),
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
    // Sealed: only what node needs from the shell, and the throwaway HOME (`os.homedir()`).
    { cwd: server, stdio: ["ignore", "ignore", "inherit"], env: { ...sealedNodeEnv(work), HOME: home } },
  );
} catch {
  // A failed T3 run leaves entries missing; the comparison reports them.
} finally {
  cleanup();
}

// ---- Ours ----
const base = NodeFS.existsSync(baseOut) ? JSON.parse(NodeFS.readFileSync(baseOut, "utf8")) : { PATH: SAFE_PATH, HOME: home };
const planFile = NodePath.join(work, "plan.json");
const rustOut = NodePath.join(work, "rust-entries.json");
const rustCwdOut = NodePath.join(work, "rust-server-cwd.txt");
NodeFS.writeFileSync(
  planFile,
  JSON.stringify({ cwdOut: rustCwdOut, scenarios: plan.map((p) => ({ name: p.name, instance: p.rustInstance })) }),
);
const binary = exampleBinary("conn-provider-codex", "codex_probe");
// The same server environment as T3's side.
NodeChildProcess.spawnSync(binary, [planFile, rustOut], {
  cwd: repoRoot,
  env: base,
  stdio: ["ignore", "inherit", "inherit"],
});

// ---- Compare ----
const readJson = (file) => (NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : undefined);
const readText = (file) => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : undefined);
const serverCwd = { ts: readText(tsCwdOut), rust: readText(rustCwdOut) };
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).toSorted().map((k) => [k, canonical(value[k])]))
      : value;
const scrub = (value, scenario, side) => {
  let text = JSON.stringify(value).replaceAll(NodePath.join(scenario.dir, side), "<stub>");
  if (serverCwd[side]) text = text.replaceAll(serverCwd[side], "<server>");
  return JSON.parse(text);
};
const stripStamps = (entry, side, scenario) => {
  if (entry === undefined) return undefined;
  const copy = scrub(entry, scenario, side);
  copy.checkedAt = "<checkedAt>";
  if (copy.usageLimits) copy.usageLimits.checkedAt = "<checkedAt>";
  return canonical(copy);
};
/**
 * Both servers send `skills/list`, `model/list`, `config/read` and `account/rateLimits/read`
 * at once (T3's `Effect.all`), so their order against each other depends on timing on either
 * side. The lines up to `account/read` stay in order; the later ones are grouped by method,
 * in order within each method (a model list's pages).
 */
const concurrentByMethod = (stdin) => {
  const cut = stdin.findIndex((line) => line?.method === "account/read") + 1;
  if (cut === 0) return stdin;
  const rest = stdin.slice(cut);
  const methods = [...new Set(rest.map((line) => line?.method ?? ""))].toSorted();
  return [...stdin.slice(0, cut), ...methods.flatMap((m) => rest.filter((line) => (line?.method ?? "") === m))];
};
// How a run ended: the signals it got. Both servers close stdin and send SIGTERM at once, so
// whether the stub saw the end of input first is timing on either side; it is not compared.
const runs = (scenario, side) => {
  const dir = NodePath.join(scenario.dir, side, "records");
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .toSorted()
    .map((f) => readJson(NodePath.join(dir, f)))
    .map((r) => {
      const stdin = r.stdin.map((line) => {
        if (line === null || typeof line !== "object") return line;
        const { id: _id, ...rest } = line;
        return rest;
      });
      return scrub({ argv: r.argv, env: r.env, cwd: r.cwd, stdin: concurrentByMethod(stdin), ended: r.ended.filter((e) => e !== "EOF") }, scenario, side);
    });
};

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
  const t3Runs = runs(scenario, "ts");
  const connRuns = runs(scenario, "rust");
  if (t3Runs.length !== connRuns.length) problems.push(`CLI runs: t3 ${t3Runs.length}, conn ${connRuns.length}`);
  for (let i = 0; i < Math.min(t3Runs.length, connRuns.length); i++) {
    for (const key of ["argv", "env", "cwd", "stdin", "ended"]) {
      const a = JSON.stringify(canonical(t3Runs[i][key]));
      const b = JSON.stringify(canonical(connRuns[i][key]));
      if (a !== b) problems.push(`run ${i} ${key} differs:\n    t3:   ${a}\n    conn: ${b}`);
    }
  }
  if (problems.length === 0) {
    console.log(`SAME ${scenario.name} (${t3Runs.length} CLI run(s), status ${t3?.status}${t3?.message ? `: ${t3.message}` : ""})`);
  } else {
    differ += 1;
    console.log(`DIFF ${scenario.name}\n  ${problems.join("\n  ")}`);
  }
}
if (!keep && differ === 0) NodeFS.rmSync(work, { recursive: true, force: true });
else console.log(`work folder: ${work}`);
console.log(differ === 0 ? "No differences." : `${differ} scenario(s) differ.`);
process.exit(differ === 0 ? 0 : 1);

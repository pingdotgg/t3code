#!/usr/bin/env node
// Conformance check for the ACP launch and wire: does conn-provider-acp start an agent and
// write to it exactly as the T3 server's adapter does?
//
//   CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/conformance.mjs [--keep] [fixture ...]
//
// No agent starts and no model is called. Both sides start a stub agent (tools/acp-stub.mjs)
// that records its argv, environment and every stdin line, and answers with the T3 server's
// own replay agent on the recorded transcript.
//
// 1. T3: one temporary vitest file in apps/server/src/orchestration-v2/testkit runs each
//    fixture through the orchestrator fixture runner with the real Grok adapter and its real
//    runtime (`makeGrokAdapterV2` without a test runtime), `binaryPath` set to the stub. The
//    file is deleted afterwards.
// 2. Rust: `cargo run --example conformance` replays the same adapter calls into
//    `AcpProvider`, with the same stub and transcript.
// 3. The two stub logs are compared: argv, the environment the child got (relative to its
//    parent's), every stdin line byte for byte (the workspace path written as <workspace>),
//    and the order of the end of input and signals.
//
// Every fixture of the flavor that passes the replay test runs; those on
// testdata/<flavor>/expected-failures.txt are skipped and listed. Any difference exits 1.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo, repoRoot } from "../../../tools/monorepo.mjs";

const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const CRATE = NodePath.dirname(HERE);
const STUB = NodePath.join(HERE, "acp-stub.mjs");
const REPLAY_AGENT = NodePath.join(MONOREPO, "apps/server/scripts/acp-replay-agent.ts");
const FLAVOR = "grok";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = args.filter((a) => !a.startsWith("--"));

const goldenDir = NodePath.join(CRATE, "testdata", FLAVOR);
const expected = new Map(
  NodeFS.readFileSync(NodePath.join(goldenDir, "expected-failures.txt"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]),
);
const fixtures = NodeFS.readdirSync(goldenDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .filter((f) => only.length === 0 || only.includes(f))
  .toSorted();
const skipped = fixtures.filter((f) => expected.has(f));
const scenarios = fixtures.filter((f) => !expected.has(f));

const work = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-acp-conformance-")));

const wrapper = (dir, transcript) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const config = NodePath.join(dir, "stub-config.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      transcript,
      status: NodePath.join(dir, "status.json"),
      log: NodePath.join(dir, "stub.ndjson"),
      replayAgent: REPLAY_AGENT,
    }),
  );
  const script = NodePath.join(dir, "grok");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} --stub-config ${JSON.stringify(config)} "$@"\n`,
    { mode: 0o755 },
  );
  return script;
};

const plan = scenarios.map((name) => {
  const dir = NodePath.join(work, name);
  const golden = JSON.parse(NodeFS.readFileSync(NodePath.join(goldenDir, `${name}.json`), "utf8"));
  const transcript = NodePath.join(dir, "transcript.json");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(transcript, JSON.stringify({ scenario: name, entries: golden.transcripts[0] }));
  const rustWorkspace = NodePath.join(dir, "workspace");
  NodeFS.mkdirSync(rustWorkspace);
  return {
    name,
    dir,
    golden: NodePath.join(goldenDir, `${name}.json`),
    tsBinary: wrapper(NodePath.join(dir, "ts"), transcript),
    binary: wrapper(NodePath.join(dir, "rust"), transcript),
    workspace: rustWorkspace,
  };
});

// ---- T3 side ------------------------------------------------------------------------------

const TEST_SOURCE = `
import * as fs from "node:fs";
import * as os from "node:os";
import { describe } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { GROK_DEFAULT_INSTANCE_ID, makeGrokAdapterV2 } from "@t3tools/provider-grok/testing";
import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

// The stub's replay agent sees the workspace as its real path; give T3 a real path too.
process.env.TMPDIR = fs.realpathSync(os.tmpdir());
const PLAN = __PLAN__;
fs.writeFileSync(__PARENT_ENV__, JSON.stringify(process.env));

const stubHarness = (binaryPath: string) => ({
  ...GrokOrchestratorReplayHarness,
  makeProviderAdapterRegistryLayer: () =>
    ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        const adapter = yield* makeGrokAdapterV2({
          instanceId: GROK_DEFAULT_INSTANCE_ID,
          settings: Schema.decodeSync(GrokSettings)({ binaryPath }),
          environment: {},
          hostPlatform: yield* HostProcess.Platform,
          selfInvocation: yield* resolveSelfInvocation(),
          continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        });
        return [adapter];
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
          NodeServices.layer,
          NodeCrypto.layer,
          IdAllocator.layer,
        ),
      ),
    ),
});

describe("conn acp conformance", () => {
  itRunsReplayFixtures("${FLAVOR}", (input) => {
    const scenario = PLAN.find((s: any) => s.name === input.fixtureName);
    if (scenario === undefined) return Effect.void;
    return runReplayFixture({ ...input, harness: stubHarness(scenario.tsBinary) as any }).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => fs.writeFileSync(scenario.dir + "/ts-outcome.txt", String(exit._tag === "Success" ? "passed" : exit.cause)))),
      Effect.asVoid,
    );
  });
});
`;

const server = NodePath.join(MONOREPO, "apps/server");
// The name carries this run's PID, so runs side by side on one checkout do not collide.
const testFile = NodePath.join(
  server,
  "src/orchestration-v2/testkit",
  `ConnAcpConformance.${process.pid}.tmp.test.ts`,
);
const tsParentEnv = NodePath.join(work, "ts-parent-env.json");
NodeFS.writeFileSync(
  testFile,
  TEST_SOURCE.replace("__PLAN__", JSON.stringify(plan)).replace("__PARENT_ENV__", JSON.stringify(tsParentEnv)),
);
try {
  NodeChildProcess.execFileSync("vp", ["test", "run", NodePath.relative(server, testFile)], {
    cwd: server,
    stdio: ["ignore", "ignore", "inherit"],
  });
} catch {
  // T3 cases that fail are reported per scenario below.
} finally {
  NodeFS.rmSync(testFile, { force: true });
}

// ---- Rust side ----------------------------------------------------------------------------

const planFile = NodePath.join(work, "plan.json");
const rustParentEnv = NodePath.join(work, "rust-parent-env.json");
NodeFS.writeFileSync(planFile, JSON.stringify({ scenarios: plan, parentEnv: rustParentEnv }));
NodeChildProcess.execFileSync(
  "cargo",
  ["run", "--quiet", "-p", "conn-provider-acp", "--example", "conformance", "--", planFile],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);

// ---- compare ------------------------------------------------------------------------------

const readLog = (file) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const envDelta = (env, parent) =>
  Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => parent[k] !== v)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
const tsParent = JSON.parse(NodeFS.readFileSync(tsParentEnv, "utf8"));
const rustParent = JSON.parse(NodeFS.readFileSync(rustParentEnv, "utf8"));
// T3 attaches a fresh trace context to each request; the values differ by design.
const scrubTrace = (line) =>
  line.replace(/"traceId":"[0-9a-f]{32}"/g, '"traceId":"<trace>"').replace(/"spanId":"[0-9a-f]{16}"/g, '"spanId":"<span>"');

let differences = 0;
const report = [];
for (const scenario of plan) {
  const ts = readLog(NodePath.join(scenario.dir, "ts", "stub.ndjson"));
  const rust = readLog(NodePath.join(scenario.dir, "rust", "stub.ndjson"));
  const problems = [];
  const outcome = NodeFS.existsSync(NodePath.join(scenario.dir, "ts-outcome.txt"))
    ? NodeFS.readFileSync(NodePath.join(scenario.dir, "ts-outcome.txt"), "utf8")
    : "not run";
  if (ts.length === 0) problems.push(`the T3 side recorded nothing (T3 outcome: ${outcome.slice(0, 300)})`);
  if (rust.length === 0) problems.push("the Rust side recorded nothing");
  const starts = (log) => log.filter((e) => e.kind === "start");
  const [tsStarts, rustStarts] = [starts(ts), starts(rust)];
  if (tsStarts.length !== rustStarts.length) {
    problems.push(`processes: T3 started ${tsStarts.length}, Rust ${rustStarts.length}`);
  }
  for (let i = 0; i < Math.min(tsStarts.length, rustStarts.length); i += 1) {
    const [a, b] = [tsStarts[i], rustStarts[i]];
    if (JSON.stringify(a.argv) !== JSON.stringify(b.argv)) {
      problems.push(`argv of process ${i}: T3 ${JSON.stringify(a.argv)} Rust ${JSON.stringify(b.argv)}`);
    }
    const tsEnv = JSON.parse(JSON.stringify(envDelta(a.env, tsParent)).replaceAll(a.cwd, "<workspace>"));
    const rustEnv = JSON.parse(JSON.stringify(envDelta(b.env, rustParent)).replaceAll(b.cwd, "<workspace>"));
    if (JSON.stringify(tsEnv) !== JSON.stringify(rustEnv)) {
      problems.push(`environment of process ${i}: T3 adds ${JSON.stringify(tsEnv)}, Rust adds ${JSON.stringify(rustEnv)}`);
    }
  }
  const lines = (log, workspace) =>
    log.filter((e) => e.kind !== "start" && e.kind !== "agent-exit").map((e) =>
      e.kind === "stdin" ? `stdin ${scrubTrace(e.line.replaceAll(workspace, "<workspace>"))}` : e.kind,
    );
  const tsWorkspace = tsStarts[0]?.cwd ?? "\u0000";
  const tsLines = lines(ts, tsWorkspace);
  const rustLines = lines(rust, scenario.workspace);
  for (let i = 0; i < Math.max(tsLines.length, rustLines.length); i += 1) {
    if (tsLines[i] !== rustLines[i]) {
      problems.push(`stdin entry ${i}:\n    T3   ${(tsLines[i] ?? "(none)").slice(0, 600)}\n    Rust ${(rustLines[i] ?? "(none)").slice(0, 600)}`);
      break;
    }
  }
  if (problems.length > 0) {
    differences += 1;
    report.push(`DIFF ${scenario.name}\n  ${problems.join("\n  ")}`);
  } else {
    report.push(`same ${scenario.name} (${tsLines.filter((l) => l.startsWith("stdin")).length} stdin lines, ${tsStarts.length} process${tsStarts.length === 1 ? "" : "es"})`);
  }
}
console.log(report.join("\n"));
for (const name of skipped) console.log(`skip ${name}: ${expected.get(name)}`);
console.log(`\n${plan.length - differences} of ${plan.length} scenarios the same; ${skipped.length} skipped.`);
if (!keep) NodeFS.rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
process.exit(differences === 0 ? 0 : 1);

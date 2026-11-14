#!/usr/bin/env node
// The T3 server's own replay fixtures (`apps/server/src/orchestration-v2/testkit`) through
// this engine and our providers, judged by T3's own assertions.
//
//   CONN_MONOREPO=/path/to/conn node crates/conn-engine/tools/t3-fixture-replay/check.mjs [--keep] [--only <fixture>/<driver>]
//
// How: one temporary vitest file in that testkit folder registers T3's fixture tests
// (`itRunsReplayFixtures`, one per fixture and driver) and runs each with T3's own
// `runReplayFixture`. That function prepares the transcript and the workspace, builds the
// scenario steps (`materializeFixtureInput`), runs them, then runs every output assertion.
// The file mocks one function: `runOrchestratorV2ProviderReplayScenario`, the one that runs
// the steps through T3's orchestrator. Ours hands the steps to
// `cargo run --example t3_fixture_replay` (this engine, the real provider, a stub CLI that
// replays the recorded transcript) and returns that run's events, projections and shell
// snapshots, decoded with the contract's own schemas. So the fixtures, the steps and the
// assertions all come from `CONN_MONOREPO`, and an upstream change shows here.
//
// The temporary file is created only when no other run's file is there, and is removed on
// exit. No model is called.
//
// `expected-failures.txt` lists the fixture variants that fail today, with the reason. The
// check fails when an unlisted one fails or a listed one passes.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo, repoRoot } from "../../../../tools/monorepo.mjs";

const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const CODEX_STUB = NodePath.join(repoRoot, "crates/conn-provider-codex/tools/codex-stub.mjs");
const CLAUDE_FAKE_HOST = NodePath.join(
  repoRoot,
  "crates/conn-provider-claude/tools/t3-replay/fake-host.mjs",
);
const EXPECTED = NodePath.join(HERE, "expected-failures.txt");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const onlyAt = args.indexOf("--only");
const only = onlyAt === -1 ? null : args[onlyAt + 1];

// The driver binary, built once.
const build = NodeChildProcess.spawnSync(
  "cargo",
  ["build", "--quiet", "-p", "conn-engine", "--example", "t3_fixture_replay"],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);
if (build.status !== 0) {
  console.error("t3-fixture-replay: the driver did not build");
  process.exit(1);
}
const targetDir = process.env.CARGO_TARGET_DIR
  ? NodePath.resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : NodePath.join(repoRoot, "target");
const DRIVER = NodePath.join(targetDir, "debug/examples/t3_fixture_replay");

const work = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-t3-fixture-replay-")),
);
const config = {
  work,
  driverBinary: DRIVER,
  codexStub: CODEX_STUB,
  claudeFakeHost: CLAUDE_FAKE_HOST,
  claudeShim: NodePath.join(HERE, "claude-session-shim.mjs"),
  node: process.execPath,
  only,
};
NodeFS.writeFileSync(NodePath.join(work, "config.json"), JSON.stringify(config));

const TEST_SOURCE = String.raw`
import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import { describe, vi } from "vitest";
import * as Effect from "effect/Effect";

import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

vi.mock("./ProviderReplayHarness.ts", async (importOriginal) => {
  const original: any = await importOriginal();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const cp = await import("node:child_process");
  const Effect = await import("effect/Effect");
  const Schema = await import("effect/Schema");
  const contracts: any = await import("@t3tools/contracts");
  const terminal: any = await import("@t3tools/shared/terminalOutput");
  const CONFIG = JSON.parse(fs.readFileSync(__CONFIG__, "utf8"));
  const json = (schema: any) => Schema.decodeUnknownSync(Schema.toCodecJson(schema));
  const decodeEvents = json(Schema.Array(contracts.OrchestrationV2StoredEvent));
  const decodeProjection = json(contracts.OrchestrationV2ThreadProjection);
  const decodeShell = json(contracts.OrchestrationV2ThreadShellSnapshot);
  let counter = 0;

  // T3 run ids (IdAllocator derive.run) to this engine's: run:<threadId>:<ordinal>.
  const ourIds = (value: any): any => {
    if (typeof value === "string") {
      const m = /^run:thread:(.+):ordinal:(\d+)$/.exec(value);
      return m ? "run:" + decodeURIComponent(m[1]) + ":" + m[2] : value;
    }
    if (Array.isArray(value)) return value.map(ourIds);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ourIds(v)]));
    }
    return value;
  };

  // The provider's stand-in: Codex gets a stub codex executable that replays the recording
  // (codex-stub.mjs); Claude gets the fake SDK host of the Claude transcript replay.
  const standIn = (driver: string, dir: string, transcript: any) => {
    if (driver === "codex") {
      fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify(transcript));
      const stubConfig = path.join(dir, "stub-config.json");
      fs.writeFileSync(
        stubConfig,
        JSON.stringify({ transcript: path.join(dir, "transcript.json"), log: path.join(dir, "stub.ndjson") }),
      );
      const wrapper = path.join(dir, "codex");
      fs.writeFileSync(
        wrapper,
        "#!/bin/sh\nexec " + JSON.stringify(CONFIG.node) + " " + JSON.stringify(CONFIG.codexStub) +
          " --stub-config " + JSON.stringify(stubConfig) + ' "$@"\n',
        { mode: 0o755 },
      );
      return { binary: wrapper };
    }
    if (driver === "claudeAgent") {
      const ndjson = path.join(dir, "transcript.ndjson");
      fs.writeFileSync(ndjson, transcript.entries.map((e: any) => JSON.stringify(e)).join("\n") + "\n");
      // T3 pins the session id to the recording's (nativeSessionIdFor); the shim maps ours.
      const recorded = transcript.metadata?.nativeSessionId ?? "00000000-0000-4000-8000-000000000000";
      return {
        binary: CONFIG.node,
        helperArgs: [CONFIG.claudeShim, recorded, CONFIG.claudeFakeHost, ndjson, path.join(dir, "host-result.json")],
      };
    }
    throw new Error("conn: driver " + driver + " is not offered by this server");
  };

  // What the stand-in saw that the recording did not expect: T3's replay fails on it.
  const frameDifference = (driver: string, dir: string): string | null => {
    if (driver === "codex") {
      const log = path.join(dir, "stub.ndjson");
      if (!fs.existsSync(log)) return null;
      for (const line of fs.readFileSync(log, "utf8").split("\n")) {
        if (line === "") continue;
        const entry = JSON.parse(line);
        if (entry.kind === "missing") return "the server never sent the recorded " + (entry.expected?.method ?? "reply");
        if (entry.kind === "extra") return "the server sent " + (entry.frame?.method ?? "a reply") + " the recording does not have";
      }
      return null;
    }
    const result = path.join(dir, "host-result.json");
    if (!fs.existsSync(result)) return null;
    const host = JSON.parse(fs.readFileSync(result, "utf8"));
    if (host.mismatch == null) return null;
    const expected = host.mismatch.expected?.type ?? JSON.stringify(host.mismatch.expected).slice(0, 80);
    const actual = host.mismatch.actual?.type ?? "nothing";
    return "the SDK host got " + actual + " where the recording has " + expected;
  };

  const runConn = (scenario: any, harness: any) =>
    Effect.promise(async () => {
      counter += 1;
      const dir = path.join(CONFIG.work, scenario.name.replace(/[^a-zA-Z0-9_-]+/g, "-") + "-" + counter);
      fs.mkdirSync(path.join(dir, "home"), { recursive: true });
      fs.mkdirSync(path.join(dir, "state"), { recursive: true });
      const provider = standIn(harness.driver, dir, scenario.transcript);
      const create = scenario.commands.find((c: any) => c.type === "thread.create");
      const out = path.join(dir, "result.json");
      const plan = {
        driver: harness.driver,
        ...provider,
        providerHome: path.join(dir, "home"),
        stateDir: path.join(dir, "state"),
        workspace: scenario.runtimePolicyOverride?.cwd,
        fixtureProjectId: create?.projectId,
        runtimePolicyOverride: scenario.runtimePolicyOverride ?? {},
        steps: ourIds(scenario.steps ?? scenario.commands.map((command: any) => ({ type: "dispatch", command, await: true }))),
        projectionThreadIds: scenario.projectionThreadIds ?? [],
        out,
      };
      fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
      const code = await new Promise<number | null>((resolve) => {
        const child = cp.spawn(CONFIG.driverBinary, [path.join(dir, "plan.json")], {
          stdio: ["ignore", "ignore", fs.openSync(path.join(dir, "driver.log"), "w")],
        });
        child.on("exit", (status) => resolve(status));
      });
      const raw = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { error: "no result (exit " + code + ")" };
      const difference = frameDifference(harness.driver, dir);
      if (difference !== null) throw new Error("provider frames differ: " + difference + " [" + dir + "]");
      if (raw.error) throw new Error("conn driver: " + raw.error + " [" + dir + "]");
      const storedEvents = decodeEvents(raw.storedEvents);
      const projections = new Map(
        Object.entries(raw.projections).map(([id, p]) => [id, decodeProjection(p)]),
      );
      return {
        storedEvents,
        domainEvents: storedEvents.map((stored: any) => stored.event),
        projections,
        shellSnapshot: decodeShell(raw.shellSnapshot),
        capturedShellSnapshots: new Map(
          Object.entries(raw.capturedShellSnapshots).map(([k, s]) => [k, decodeShell(s)]),
        ),
        // T3's CommandOutputRecorder: chunk count and appendTerminalOutput over the chunks.
        commandOutput: new Map(
          Object.entries(raw.commandOutput ?? {}).map(([item, chunks]: [string, any]) => [
            item,
            {
              chunks: chunks.length,
              output: chunks.reduce(
                (state: any, chunk: string) => terminal.appendTerminalOutput(state, chunk),
                terminal.EMPTY_TERMINAL_OUTPUT,
              ),
            },
          ]),
        ),
      };
    });

  return { ...original, runOrchestratorV2ProviderReplayScenario: runConn };
});

const CONFIG = JSON.parse(fs.readFileSync(__CONFIG__, "utf8"));
const generic = (driver: string) => ({
  driver,
  decodeTranscript: (transcript: any) => Effect.succeed(transcript),
  makeProviderAdapterRegistryLayer: () => {
    throw new Error("unused");
  },
});

const drivers = [...new Set(ORCHESTRATOR_REPLAY_FIXTURES.flatMap((f) => f.providers.map((p) => p.driver)))];
fs.writeFileSync(
  path.join(CONFIG.work, "variants.json"),
  JSON.stringify(
    ORCHESTRATOR_REPLAY_FIXTURES.flatMap((f) => f.providers.map((p) => f.name + "/" + p.driver)),
  ),
);

describe("conn engine: T3 replay fixtures", () => {
  for (const driver of drivers) {
    itRunsReplayFixtures(driver, (input: any) => {
      if (CONFIG.only !== null && CONFIG.only !== input.fixtureName + "/" + driver) {
        return Effect.void;
      }
      // Each driver as its own T3 test file runs it.
      if (driver === "codex") {
        return runReplayFixture({
          ...input,
          harness: CodexOrchestratorReplayHarness,
          materializeWorkspace: (transcript: any, workspace: string) =>
            Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
        });
      }
      if (driver === "claudeAgent") {
        return runReplayFixture({ ...input, harness: ClaudeOrchestratorReplayHarness });
      }
      return runReplayFixture({ ...input, harness: generic(driver) as any });
    });
  }
});
`;

const server = NodePath.join(MONOREPO, "apps/server");
// The name carries this run's PID, so runs side by side on one checkout do not collide.
const testFile = NodePath.join(
  server,
  "src/orchestration-v2/testkit",
  `ConnEngineFixtureReplay.${process.pid}.tmp.test.ts`,
);
const cleanup = () => NodeFS.rmSync(testFile, { force: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}
const reportFile = NodePath.join(work, "report.json");
NodeFS.writeFileSync(
  testFile,
  TEST_SOURCE.replaceAll("__CONFIG__", JSON.stringify(NodePath.join(work, "config.json"))),
);
try {
  NodeChildProcess.spawnSync(
    "vp",
    [
      "test",
      "run",
      NodePath.relative(server, testFile),
      "--reporter=json",
      `--outputFile=${reportFile}`,
      "--testTimeout=120000",
      // Each fixture has its own folder, engine and stub process: four at a time.
      "--sequence.concurrent",
      "--maxConcurrency=4",
    ],
    { cwd: server, stdio: ["ignore", "ignore", "inherit"] },
  );
} finally {
  cleanup();
}
if (!NodeFS.existsSync(reportFile)) {
  console.error(`t3-fixture-replay: vitest wrote no report; work folder: ${work}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------
// Compare with the expected failures.
// ---------------------------------------------------------------------------------------

const report = JSON.parse(NodeFS.readFileSync(reportFile, "utf8"));
const results = new Map();
for (const file of report.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    const m = /runs (\S+)\/(\S+) through/.exec(test.title ?? test.fullName ?? "");
    if (m === null) continue;
    const message = (test.failureMessages ?? []).join("\n").split("\n")[0] ?? "";
    results.set(`${m[1]}/${m[2]}`, { status: test.status, message });
  }
}
const variants = JSON.parse(NodeFS.readFileSync(NodePath.join(work, "variants.json"), "utf8"));

const expected = new Map();
for (const line of NodeFS.readFileSync(EXPECTED, "utf8").split("\n")) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const [name, ...reason] = trimmed.split(/\s+/);
  expected.set(name, reason.join(" "));
}

const byDriver = new Map();
let open = 0;
const lines = [];
for (const variant of variants) {
  if (only !== null && variant !== only) continue;
  const driver = variant.split("/").at(-1);
  const counts = byDriver.get(driver) ?? { passed: 0, total: 0 };
  counts.total += 1;
  const result = results.get(variant) ?? { status: "missing", message: "no test result" };
  const passed = result.status === "passed";
  if (passed) counts.passed += 1;
  byDriver.set(driver, counts);
  // `*/<driver>` lists every variant of a provider this server does not offer.
  const listed = expected.has(variant) || expected.has(`*/${driver}`);
  if (passed && listed) {
    open += 1;
    lines.push(`PASSES BUT LISTED  ${variant}: remove it from expected-failures.txt`);
  } else if (!passed && !listed) {
    open += 1;
    lines.push(`FAILS, NOT LISTED  ${variant}: ${result.message}`);
  } else if (!passed && process.env.T3_REPLAY_VERBOSE) {
    lines.push(`expected failure   ${variant}: ${result.message}`);
  }
}
for (const name of expected.keys()) {
  const wildcard = name.startsWith("*/") && variants.some((v) => v.endsWith(name.slice(1)));
  if (!wildcard && !variants.includes(name)) {
    open += 1;
    lines.push(`LISTED, NO SUCH VARIANT  ${name}: T3 removed or renamed it`);
  }
}
for (const line of lines) console.log(line);
const total = [...byDriver.values()].reduce((n, c) => n + c.total, 0);
const passed = [...byDriver.values()].reduce((n, c) => n + c.passed, 0);
console.log(
  `t3-fixture-replay: ${passed} of ${total} fixture variants pass (${[...byDriver.entries()]
    .map(([d, c]) => `${d} ${c.passed}/${c.total}`)
    .join(", ")})`,
);
console.log(open === 0 ? "ok: every result is as expected" : `FAIL: ${open} unexpected result(s)`);
if (keep || open > 0) console.log(`work folder: ${work}`);
else NodeFS.rmSync(work, { recursive: true, force: true });
process.exit(open === 0 ? 0 : 1);

#!/usr/bin/env node
// Conformance check for Antigravity's launch and wire: does conn-provider-acp start `agy acp`
// and write to it exactly as the T3 server's Antigravity driver and adapter do?
//
//   node crates/conn-provider-acp/tools/antigravity-conformance.mjs [--keep] [--t3-only]
//
// No agent starts and no model is called. Both sides start the stub agent (tools/acp-stub.mjs,
// named `agy`), which records its argv, environment and every stdin line and answers with T3's
// replay agent on `testdata/antigravity/turns.json`, a recording of a live `agy acp` 1.5.4
// (`tools/make-antigravity-transcript.mjs`). T3 has no Antigravity replay fixtures, and T3's
// mock agent answers in ACP v2 where `agy` answers in v1, so the transcript and scenarios are here.
//
// 1. T3: a temporary vitest file builds the driver's runtime as `AntigravityDriver.makeRuntime`
//    does for an `agy` CLI found by path (`prepareAntigravityProfile`,
//    `buildAntigravityAcpSpawnInput`, `makeAntigravityAcpRuntime`, the CLI's session modes) and
//    runs each scenario through `makeAntigravityAdapterV2`. The file is deleted afterwards.
// 2. Rust: `cargo run --example antigravity_conformance` runs the same scenarios on
//    `AcpProvider` with the Antigravity flavor.
// 3. The stub logs are compared: argv, the environment the child got (relative to its parent's),
//    and every stdin line. Paths of each side's state folder, workspace and attachments folder
//    are written as placeholders. Accepted difference: `BROWSER` names each server's own
//    browser helper (T3: Node and an inline script; ours: this server's executable).

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { exampleBinary } from "../../../tools/check-binaries.mjs";
import { monorepo, repoRoot } from "../../../tools/monorepo.mjs";
import { sealedNodeEnv } from "../../../tools/sealed-env.mjs";
import { GUARD_IMPORT } from "../../../tools/no-outside-fetch.mjs";

const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const STUB = NodePath.join(HERE, "acp-stub.mjs");
const REPLAY_AGENT = NodePath.join(MONOREPO, "apps/server/scripts/acp-replay-agent.ts");
const TRANSCRIPT = NodePath.join(NodePath.dirname(HERE), "testdata", "antigravity", "turns.json");
const API_KEY = "conformance-gemini-key";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const t3Only = args.includes("--t3-only");

// Each turn: the message, the selected model, the runtime mode of its policy. Every scenario
// plays the same transcript: one model switch, two prompts, the close.
const SCENARIOS = [
  {
    name: "full-access",
    turns: [
      { text: "Reply with exactly: pong", model: "gemini-3.8-flash", runtimeMode: "full-access" },
      { text: "again", model: "gemini-3.8-flash", runtimeMode: "full-access" },
    ],
  },
  {
    name: "approval-required",
    turns: [
      { text: "hello", model: "gemini-3.8-flash", runtimeMode: "approval-required" },
      { text: "/goal ship it", model: "gemini-3.8-flash", runtimeMode: "auto-accept-edits" },
    ],
  },
];

const work = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-agy-conformance-")),
);

const wrapper = (dir) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const config = NodePath.join(dir, "stub-config.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      log: NodePath.join(dir, "stub.ndjson"),
      replayAgent: REPLAY_AGENT,
      transcript: TRANSCRIPT,
      status: NodePath.join(dir, "status.json"),
      gates: [],
      gateDir: dir,
    }),
  );
  // The driver takes an executable named `agy` as the CLI (`isAntigravityCli`).
  const script = NodePath.join(dir, "bin", "agy");
  NodeFS.mkdirSync(NodePath.dirname(script), { recursive: true });
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} --stub-config ${JSON.stringify(config)} "$@"\n`,
    { mode: 0o755 },
  );
  return script;
};

const side = (dir) => {
  const state = NodePath.join(dir, "state");
  const workspace = NodePath.join(dir, "workspace");
  NodeFS.mkdirSync(state, { recursive: true });
  NodeFS.mkdirSync(workspace, { recursive: true });
  return { binary: wrapper(dir), state, workspace, log: NodePath.join(dir, "stub.ndjson") };
};

const plan = SCENARIOS.map((scenario) => {
  const dir = NodePath.join(work, scenario.name);
  return {
    ...scenario,
    dir,
    apiKey: API_KEY,
    ts: side(NodePath.join(dir, "ts")),
    rust: side(NodePath.join(dir, "rust")),
  };
});

// ---- T3 side ------------------------------------------------------------------------------

const TEST_SOURCE = `
import * as fs from "node:fs";
import * as os from "node:os";
import { describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcessSpawner } from "effect/process";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  antigravityCliSessionMode,
  makeAntigravityAcpRuntime,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  buildAntigravityAcpSpawnInput,
  prepareAntigravityProfile,
  resolveAntigravityInstanceDirectories,
} from "../../provider/antigravityAuthSupport.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());
const PLAN = __PLAN__;
fs.writeFileSync(__PARENT_ENV__, JSON.stringify(process.env));

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const runScenario = (scenario: any) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const random = yield* SecureRandom.SecureRandom;
    const host = yield* ProviderHost.ProviderHost;
    fs.writeFileSync(scenario.dir + "/ts-attachments.txt", host.paths.attachmentsDir);
    const instanceId = ProviderInstanceId.make("antigravity");
    const auth = { authMethod: "gemini-api-key" as const, apiKey: scenario.apiKey, gcpProject: "", gcpLocation: "" };
    const baseEnv = { ...process.env };
    const directories = yield* resolveAntigravityInstanceDirectories(scenario.ts.state, instanceId);
    const profile = yield* prepareAntigravityProfile({
      profileDirectory: directories.profile,
      baseEnv,
      auth,
      userHome: baseEnv.HOME ?? os.homedir(),
      tempDirectory: directories.runtimeTemp,
    });
    const adapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
      profileDirectory: directories.profile,
      makeRuntime: (input) =>
        Effect.gen(function* () {
          const runtimeTempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            directory: profile.tempDirectory,
            prefix: "run-",
          });
          const { processEnvironment, ...runtimeInput } = input;
          const runtime = yield* makeAntigravityAcpRuntime({
            ...runtimeInput,
            runtimeVersion: null,
            authMethod: auth.authMethod,
            childProcessSpawner: spawner,
            spawn: buildAntigravityAcpSpawnInput({
              installation: { executablePath: scenario.ts.binary, harnessPath: null },
              profile,
              cwd: runtimeInput.cwd,
              baseEnv: processEnvironment === undefined ? baseEnv : { ...baseEnv, ...processEnvironment },
              auth,
              runtimeTempDirectory,
            }),
          }).pipe(Effect.provideService(SecureRandom.SecureRandom, random));
          return { ...runtime, setMode: (modeId: string) => runtime.setMode(antigravityCliSessionMode(modeId)) };
        }).pipe(Effect.orDie),
    });
    const threadId = ThreadId.make("thread-agy-conformance");
    const policy = (runtimeMode: any) =>
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "default",
        cwd: scenario.ts.workspace,
      });
    const first = scenario.turns[0];
    const selection = (model: string) => ({ instanceId, model }) as const;
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-agy-conformance"),
      modelSelection: selection(first.model),
      runtimePolicy: policy(first.runtimeMode),
    });
    const events = yield* Queue.unbounded<any>();
    yield* session.events.pipe(Stream.runForEach((event) => Queue.offer(events, event)), Effect.forkScoped);
    const providerThread = yield* session.ensureThread({
      threadId,
      modelSelection: selection(first.model),
      runtimePolicy: policy(first.runtimeMode),
    });
    const now = yield* DateTime.now;
    let ordinal = 0;
    for (const turn of scenario.turns) {
      ordinal += 1;
      yield* session.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy: policy(turn.runtimeMode),
          modelSelection: selection(turn.model),
          now,
          ordinal,
          messageText: turn.text,
        }),
      );
      const terminal = yield* Stream.fromQueue(events).pipe(
        Stream.filter((event: any) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      fs.appendFileSync(scenario.dir + "/ts-outcome.txt", JSON.stringify(terminal) + "\\n");
    }
  }).pipe(Effect.provide(layer), Effect.scoped);

describe("conn antigravity conformance", () => {
  for (const scenario of PLAN) {
    it.live(scenario.name, () => runScenario(scenario));
  }
});
`;

const server = NodePath.join(MONOREPO, "apps/server");
const testFile = NodePath.join(
  server,
  "src/orchestration-v2/Adapters",
  `ConnAntigravityConformance.${process.pid}.tmp.test.ts`,
);
const tsParentEnv = NodePath.join(work, "ts-parent-env.json");
NodeFS.writeFileSync(
  testFile,
  GUARD_IMPORT +
    TEST_SOURCE.replace("__PLAN__", JSON.stringify(plan)).replace(
      "__PARENT_ENV__",
      JSON.stringify(tsParentEnv),
    ),
);
try {
  NodeChildProcess.execFileSync("vp", ["test", "run", NodePath.relative(server, testFile)], {
    cwd: server,
    stdio: ["ignore", t3Only ? "inherit" : "ignore", "inherit"],
    env: sealedNodeEnv(NodePath.join(work, "ts-env")),
  });
} catch {
  // Reported per scenario below.
} finally {
  NodeFS.rmSync(testFile, { force: true });
}

// ---- Rust side ----------------------------------------------------------------------------

const rustParentEnv = NodePath.join(work, "rust-parent-env.json");
if (!t3Only) {
  const planFile = NodePath.join(work, "plan.json");
  NodeFS.writeFileSync(planFile, JSON.stringify({ scenarios: plan, parentEnv: rustParentEnv }));
  NodeChildProcess.execFileSync(
    NodePath.join(repoRoot, "tools/cargo-runner"),
    [exampleBinary("conn-provider-acp", "antigravity_conformance"), planFile],
    {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
      env: sealedNodeEnv(NodePath.join(work, "rust-env")),
    },
  );
}

// ---- compare ------------------------------------------------------------------------------

const settled = (file) => {
  if (!NodeFS.existsSync(file)) return true;
  const entries = NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return (
    entries.filter((e) => e.kind === "start").length <=
    entries.filter((e) => e.kind === "worker-exit").length
  );
};
const until = Date.now() + 20_000;
while (
  Date.now() < until &&
  !plan.every((s) => settled(s.ts.log) && (t3Only || settled(s.rust.log)))
) {
  NodeChildProcess.execFileSync("sleep", ["0.1"]);
}

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
const scrub = (text, places) => {
  let out = text;
  for (const [path, name] of places) out = out.replaceAll(path, name);
  return out
    .replace(/"traceId":"[0-9a-f]{32}"/g, '"traceId":"<trace>"')
    .replace(/"spanId":"[0-9a-f]{16}"/g, '"spanId":"<span>"')
    .replace(/run-[A-Za-z0-9_]+/g, "run-<random>");
};
// T3's MCP bridge and browser helper run its own Node; ours run this server's executable.
const scrubEnv = (env) => {
  const out = { ...env };
  if ("BROWSER" in out) out.BROWSER = "<browser helper>";
  return out;
};

const tsParent = JSON.parse(NodeFS.readFileSync(tsParentEnv, "utf8"));
const rustParent = t3Only ? {} : JSON.parse(NodeFS.readFileSync(rustParentEnv, "utf8"));
const places = (scenario, which) => {
  const s = scenario[which];
  const attachments =
    which === "ts"
      ? NodeFS.existsSync(NodePath.join(scenario.dir, "ts-attachments.txt"))
        ? NodeFS.readFileSync(NodePath.join(scenario.dir, "ts-attachments.txt"), "utf8")
        : "\u0000"
      : NodePath.join(s.state, "attachments");
  return [
    [attachments, "<attachments>"],
    [s.workspace, "<workspace>"],
    [s.state, "<state>"],
    [s.binary, "<agy>"],
  ];
};
const view = (scenario, which, parent) => {
  const log = readLog(scenario[which].log);
  const p = places(scenario, which);
  return {
    starts: log
      .filter((e) => e.kind === "start")
      .map((e) => ({
        argv: JSON.parse(scrub(JSON.stringify(e.argv), p)),
        env: JSON.parse(scrub(JSON.stringify(scrubEnv(envDelta(e.env, parent))), p)),
      })),
    lines: log
      .filter((e) => e.kind === "stdin")
      .map((e) => scrub(e.line, p)),
  };
};

let differences = 0;
for (const scenario of plan) {
  const ts = view(scenario, "ts", tsParent);
  const outcome = NodeFS.existsSync(NodePath.join(scenario.dir, "ts-outcome.txt"))
    ? NodeFS.readFileSync(NodePath.join(scenario.dir, "ts-outcome.txt"), "utf8").trim()
    : "no outcome";
  if (t3Only) {
    console.log(`== ${scenario.name} (T3 outcome: ${outcome.slice(0, 200)})`);
    console.log(JSON.stringify(ts.starts, null, 1));
    for (const line of ts.lines) console.log(line);
    continue;
  }
  const rust = view(scenario, "rust", rustParent);
  const problems = [];
  if (ts.lines.length === 0) problems.push(`the T3 side recorded nothing (T3 outcome: ${outcome.slice(0, 300)})`);
  if (rust.lines.length === 0) problems.push("the Rust side recorded nothing");
  if (ts.starts.length !== rust.starts.length) {
    problems.push(`processes: T3 started ${ts.starts.length}, Rust ${rust.starts.length}`);
  }
  for (let i = 0; i < Math.min(ts.starts.length, rust.starts.length); i += 1) {
    const [a, b] = [ts.starts[i], rust.starts[i]];
    if (JSON.stringify(a.argv) !== JSON.stringify(b.argv)) {
      problems.push(`argv ${i}: T3 ${JSON.stringify(a.argv)} Rust ${JSON.stringify(b.argv)}`);
    }
    if (JSON.stringify(a.env) !== JSON.stringify(b.env)) {
      problems.push(`environment ${i}: T3 adds ${JSON.stringify(a.env)}, Rust adds ${JSON.stringify(b.env)}`);
    }
  }
  for (let i = 0; i < Math.max(ts.lines.length, rust.lines.length); i += 1) {
    if (ts.lines[i] !== rust.lines[i]) {
      problems.push(
        `stdin line ${i}:\n    T3   ${(ts.lines[i] ?? "(none)").slice(0, 800)}\n    Rust ${(rust.lines[i] ?? "(none)").slice(0, 800)}`,
      );
      break;
    }
  }
  if (problems.length > 0) {
    differences += 1;
    console.log(`DIFF ${scenario.name}\n  ${problems.join("\n  ")}`);
  } else {
    console.log(`same ${scenario.name} (${ts.lines.length} stdin lines, ${ts.starts.length} process(es))`);
  }
}
if (!t3Only) console.log(`\n${plan.length - differences} of ${plan.length} scenarios the same.`);
if (!keep) NodeFS.rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
process.exit(differences === 0 ? 0 : 1);

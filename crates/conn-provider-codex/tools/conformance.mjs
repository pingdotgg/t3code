#!/usr/bin/env node
// Conformance check for the Codex launch and wire: does conn-provider-codex start
// `codex app-server` and write to it exactly as the T3 server's CodexAdapterV2 does?
//
//   CONN_MONOREPO=/path/to/conn node crates/conn-provider-codex/tools/conformance.mjs [--keep] [scenario ...]
//
// No model is called. Both sides start a stub `codex` (tools/codex-stub.mjs) that records its
// argv, environment and every stdin line, and replays a recorded app-server transcript:
//
// 1. TS: one temporary vitest file in apps/server/src/orchestration-v2/testkit runs each
//    scenario through the orchestrator fixture runner with the real CodexAdapterV2 and its
//    real process factory (`layerAppServerClientFactory`), `binaryPath` set to the stub. It
//    records the adapter calls and events, and the materialized transcript. The file is
//    deleted afterwards.
// 2. Rust: `cargo run --example conformance` replays the same adapter calls into
//    `CodexProvider`, with the same stub and transcript.
// 3. The two stub logs are compared: argv, the environment the child got (relative to the
//    parent's), and every stdin frame in order (method and params; request ids renumbered).
//
// Differences listed in KNOWN (with the reason) are reported but do not fail the check. Any
// other difference exits 1. Rerun on every Codex CLI change and every pinned-commit change.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo, repoRoot } from "../../../tools/monorepo.mjs";

const MONOREPO = monorepo();
const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const STUB = NodePath.join(HERE, "codex-stub.mjs");

/**
 * Scenarios: a recorded fixture, optionally changed.
 * - `mcp`: the thread has T3's MCP session (`t3-code` servers, additionalContext).
 * - `attachments`: the first message carries an image and a file.
 * - `setModelBefore`: a `set_model` step before the message with this index.
 */
const SCENARIOS = {
  simple: { fixture: "simple", covers: "initialize, fresh thread and turn" },
  resume: { fixture: "provider_thread_resume", covers: "a resumed thread on a new process" },
  mcp: { fixture: "simple", mcp: true, covers: "a turn with the t3-code MCP server" },
  approval: { fixture: "tool_call_read_only_on_request", covers: "an approval and its answer" },
  interrupt: { fixture: "turn_interrupt", covers: "an interrupt" },
  model: {
    fixture: "multi_turn",
    setModelBefore: { index: 1, model: "gpt-6-astra" },
    covers: "a model and effort change between turns",
  },
  attachment: { fixture: "simple", attachments: true, covers: "a turn with attachments" },
  rollback: { fixture: "thread_rollback", covers: "rollback to an earlier turn" },
  rollbackRestart: {
    fixture: "thread_rollback_after_restart",
    covers: "rollback after the thread was released",
  },
  rollbackStopped: {
    fixture: "thread_rollback_to_stopped_turn",
    covers: "rollback to an interrupted turn",
  },
  fork: {
    fixture: "simple",
    transcript: "thread_fork_native_prior_turn",
    steps: [
      { type: "message", text: "For this fork-boundary fixture, respond with exactly: fork boundary alpha" },
      { type: "message", text: "For this fork-boundary fixture, respond with exactly: fork boundary beta" },
      {
        type: "fork",
        fromRunIndex: 1,
        text: "Repeat the user-visible conversation so far verbatim. Include only user and assistant messages. Do not include hidden system/developer content.",
      },
    ],
    covers: "a native fork at an earlier turn",
  },
};

/**
 * Differences that are known and explained. `scenario` null means every scenario. `match`
 * gets a difference record and returns true when it is this one.
 */
const KNOWN = [
  {
    scenario: "rollbackRestart",
    reason:
      "as in resume: the fixture releases the first process by advancing the TS test clock 31 minutes",
    match: (d) =>
      d.kind === "shutdown" && d.process === 0 && /SIGTERM@\d+ms > killed@0ms$/.test(d.ts),
  },
  {
    scenario: "fork",
    reason:
      "Conn Server opens one session per app thread; when the source thread's session closes while the fork's session still uses the process it unloads the source thread, as TS does for an idle thread (unloadThread). TS's single shared session stops the process without it at the end of the test",
    match: (d) => d.kind === "rust-only-frame" && d.method === "thread/unsubscribe",
  },
  {
    scenario: "resume",
    reason:
      "the fixture releases the first process by advancing the TS test clock 31 minutes, so its 2 s SIGKILL deadline passes at once; not a server behaviour",
    match: (d) =>
      d.kind === "shutdown" && d.process === 0 && /SIGTERM@\d+ms > killed@0ms$/.test(d.ts),
  },
];

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const names = args.filter((a) => !a.startsWith("--"));
const selected = names.length > 0 ? names : Object.keys(SCENARIOS);
for (const name of selected) {
  if (!(name in SCENARIOS)) {
    console.error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(2);
  }
}

const work = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-codex-conformance-")));
const codexHome = NodePath.join(work, "codex-home");
const attachmentsDir = NodePath.join(work, "attachments");
NodeFS.mkdirSync(codexHome);
NodeFS.mkdirSync(attachmentsDir);
// A 1x1 PNG and a text file, stored as T3's attachment store names them (`<id><ext>`).
NodeFS.writeFileSync(
  NodePath.join(attachmentsDir, "conf-image-1.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
    "base64",
  ),
);
NodeFS.writeFileSync(NodePath.join(attachmentsDir, "conf-file-1.txt"), "conformance notes\n");

const wrapper = (dir) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const config = NodePath.join(dir, "stub-config.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      transcript: NodePath.join(NodePath.dirname(dir), "transcript.json"),
      log: NodePath.join(dir, "stub.ndjson"),
    }),
  );
  const script = NodePath.join(dir, "codex");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} --stub-config ${JSON.stringify(config)} "$@"\n`,
    { mode: 0o755 },
  );
  return script;
};

const plan = selected.map((name) => {
  const dir = NodePath.join(work, name);
  return {
    name,
    dir,
    ...SCENARIOS[name],
    tsCodex: wrapper(NodePath.join(dir, "ts")),
    rustCodex: wrapper(NodePath.join(dir, "rust")),
  };
});
NodeFS.writeFileSync(
  NodePath.join(work, "plan.json"),
  JSON.stringify({ codexHome, attachmentsDir, scenarios: plan }, null, 2),
);

// ---------------------------------------------------------------------------------------
// 1. TS
// ---------------------------------------------------------------------------------------

const TEST_SOURCE = `
import * as fs from "node:fs";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as CodexAdapterV2 from "../Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeReplayServerConfig } from "./ProviderReplayHarness.ts";
import { findReplayFixture, runReplayFixture } from "./ProviderReplayFixtures.ts";

const PLAN = JSON.parse(fs.readFileSync(__PLAN__, "utf8"));
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
// Calls whose answer is compared with the Rust provider's.
const RESULTS = new Set(["rollbackThread", "forkThread"]);

const safeJson = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "function" || typeof v === "symbol" ? undefined : v));

const attachments = [
  { type: "image", id: "conf-image-1", name: "pixel.png", mimeType: "image/png", sizeBytes: 70 },
  { type: "file", id: "conf-file-1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 18 },
];

const changedInput = (scenario: any, base: any) => {
  let steps = [...(scenario.steps ?? base.steps)];
  if (scenario.attachments) {
    const first = steps.findIndex((s: any) => s.type === "message");
    steps[first] = { ...steps[first], attachments };
  }
  if (scenario.setModelBefore) {
    let seen = -1;
    const at = steps.findIndex((s: any) => s.type === "message" && ++seen === scenario.setModelBefore.index);
    steps = [...steps.slice(0, at), { type: "set_model", model: scenario.setModelBefore.model }, ...steps.slice(at)];
  }
  return { ...base, steps };
};

const mcpLayer = (scenario: any) =>
  Layer.succeed(McpProviderSessions.McpProviderSessions, {
    set: () => Effect.void,
    read: (threadId: any) =>
      Effect.succeed({
        environmentId: "env-conformance",
        threadId,
        providerSessionId: "provider-session:conformance",
        providerInstanceId: "codex",
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer conformance-token",
        browserToolsAvailable: true,
      } as any),
    clear: () => Effect.void,
    recordHtmlRender: () => Effect.void,
    takeHtmlRender: () => Effect.succeed(undefined),
  } as any);

const harnessFor = (scenario: any, log: Array<unknown>) => {
  const factory = CodexAdapterV2.layerAppServerClientFactory.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => {} })),
    Layer.provide(
      Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, { native: undefined, canonical: undefined } as any),
    ),
  );
  const serverConfig = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(scenario.name).pipe(
      Effect.map((config) => ({ ...config, attachmentsDir: PLAN.attachmentsDir })),
      Effect.orDie,
    ),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const adapterLayer = (transcript: any) => {
    fs.writeFileSync(\`\${scenario.dir}/transcript.json\`, JSON.stringify(transcript));
    fs.writeFileSync(\`\${scenario.dir}/ts/env.json\`, JSON.stringify(process.env));
    const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
      CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: { ...DEFAULT_CODEX_SETTINGS, binaryPath: scenario.tsCodex, homePath: PLAN.codexHome },
      }).pipe(Effect.map((adapter) => [adapter])),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(factory, serverConfig, NodeServices.layer, NodeCrypto.layer, IdAllocator.layer),
      ),
    );
    return scenario.mcp ? registry.pipe(Layer.provide(mcpLayer(scenario))) : registry;
  };
  return {
    ...CodexOrchestratorReplayHarness,
    makeProviderAdapterRegistryLayer: (transcript: any) =>
      Layer.effect(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        Effect.gen(function* () {
          const ctx = yield* Layer.build(adapterLayer(transcript) as any);
          const registry = (ctx as any).mapUnsafe.get(ProviderAdapterRegistry.ProviderAdapterRegistryV2.key) as any;
          return {
            ...registry,
            get: (id: any) =>
              registry.get(id).pipe(
                Effect.map((adapter: any) => ({
                  ...adapter,
                  openSession: (input: any) => {
                    log.push({ kind: "call", method: "openSession", input });
                    return adapter.openSession(input).pipe(
                      Effect.map((runtime: any) => {
                        const wrapped: any = { ...runtime };
                        for (const [key, value] of Object.entries(runtime)) {
                          if (typeof value !== "function" || key === "subscribeEvents") continue;
                          wrapped[key] = (...callArgs: Array<unknown>) => {
                            log.push({ kind: "call", method: key, input: callArgs[0] ?? null });
                            const out = (value as any)(...callArgs);
                            return RESULTS.has(key) && Effect.isEffect(out)
                              ? (out as any).pipe(
                                  Effect.tap((output: unknown) =>
                                    Effect.sync(() => log.push({ kind: "result", method: key, output })),
                                  ),
                                )
                              : out;
                          };
                        }
                        wrapped.events = runtime.events.pipe(
                          Stream.tap((event: any) => Effect.sync(() => log.push({ kind: "event", event }))),
                        );
                        return wrapped;
                      }),
                    );
                  },
                })),
              ),
          };
        }),
      ),
  };
};

describe("conn codex conformance", () => {
  for (const scenario of PLAN.scenarios) {
    it.effect(scenario.name, () => {
      const log: Array<unknown> = [];
      const fixture = findReplayFixture(scenario.fixture)!;
      // A recording without a Codex fixture entry (provider_thread_resume), or a scenario with
      // its own steps and recording, runs with the simple fixture's Codex settings and no
      // output assertions.
      const own = scenario.transcript === undefined ? fixture.providers.find((p: any) => p.driver === "codex") : undefined;
      const recording = scenario.transcript ?? scenario.fixture;
      const driver =
        own ?? {
          ...findReplayFixture("simple")!.providers.find((p: any) => p.driver === "codex")!,
          recordedScenario: recording,
          transcriptFile: new URL(\`./fixtures/\${recording}/codex_transcript.ndjson\`, import.meta.url),
          assertOutput: () => {},
        };
      return runReplayFixture({
        fixtureName: scenario.fixture,
        buildInput: () => changedInput(scenario, fixture.buildInput()),
        driver,
        harness: harnessFor(scenario, log) as any,
        materializeWorkspace: (transcript, workspace) =>
          Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
      }).pipe(
        Effect.exit,
        Effect.map((exit) => {
          fs.writeFileSync(
            \`\${scenario.dir}/ts/calls.json\`,
            safeJson({ ok: Exit.isSuccess(exit), failure: Exit.isSuccess(exit) ? null : String(exit.cause), log }),
          );
        }),
      );
    }, 30_000);
  }
});
`;

const server = NodePath.join(MONOREPO, "apps/server");
const testFile = NodePath.join(
  server,
  "src/orchestration-v2/testkit",
  `ConnCodexConformance.${process.pid}.tmp.test.ts`,
);
NodeFS.writeFileSync(
  testFile,
  TEST_SOURCE.replace("__PLAN__", JSON.stringify(NodePath.join(work, "plan.json"))),
);
let tsStatus;
try {
  tsStatus = NodeChildProcess.spawnSync("vp", ["test", "run", NodePath.relative(server, testFile)], {
    cwd: server,
    stdio: ["ignore", "inherit", "inherit"],
  }).status;
} finally {
  NodeFS.rmSync(testFile, { force: true });
}
if (tsStatus !== 0) {
  console.error(`the TS side failed (vp test exit ${tsStatus}); work folder: ${work}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------
// 2. Rust
// ---------------------------------------------------------------------------------------

const rust = NodeChildProcess.spawnSync(
  "cargo",
  ["run", "--quiet", "-p", "conn-provider-codex", "--example", "conformance", "--", NodePath.join(work, "plan.json")],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);
if (rust.status !== 0) {
  console.error(`the Rust side failed (exit ${rust.status}); work folder: ${work}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------
// 3. Compare
// ---------------------------------------------------------------------------------------

const readLog = (path) =>
  NodeFS.existsSync(path)
    ? NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : [];

/** Each process start with the frames it got, in order. */
const processes = (log) => {
  const out = [];
  for (const entry of log) {
    if (entry.kind === "start") out.push({ start: entry, frames: [], extra: [], missing: [], end: [] });
    const current = out.at(-1);
    if (current === undefined) continue;
    if (entry.kind === "in") current.frames.push(entry.frame ?? { invalid: entry.line });
    if (entry.kind === "extra") current.extra.push(entry.frame);
    if (entry.kind === "missing") current.missing.push(entry.expected);
    if (entry.kind === "alive") current.lastAlive = entry.afterMs;
    if (["SIGTERM", "SIGINT", "SIGHUP", "stdin-end", "linger-exit"].includes(entry.kind)) {
      current.end.push({ kind: entry.kind, afterMs: entry.afterMs });
    }
  }
  // No `linger-exit`: the client killed the stub (SIGKILL) before the linger ended.
  for (const p of out) {
    if (!p.end.some((e) => e.kind === "linger-exit")) p.end.push({ kind: "killed", afterMs: p.lastAlive ?? 0 });
  }
  return out;
};

/** The child's environment as a change to its parent's. */
const envDelta = (child, parent) => {
  const delta = {};
  for (const [key, value] of Object.entries(child)) {
    if (parent[key] !== value) delta[key] = value;
  }
  for (const key of Object.keys(parent)) if (!(key in child)) delta[key] = "<removed>";
  return delta;
};

// Variables a launcher adds by itself, not the server: the Node and cargo processes that
// host each side set these, and the stub's interpreter adds none of its own.
const HOST_NOISE = /^(npm_|NODE_|VITEST|VITE_|TEST$|CARGO|RUST|__CF|TERM_|PNPM|VP_|OLDPWD$|PWD$|_$|SHLVL$|MallocNanoZone$|TS_|FORCE_COLOR|NO_COLOR|COLORTERM)/;

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
};

/** Frames with request ids renumbered from 1 in send order; replies keep the server's id. */
const normalizeFrames = (frames) => {
  let next = 0;
  return frames.map((frame) => {
    const copy = { ...frame };
    if (copy.method !== undefined && copy.id !== undefined) copy.id = ++next;
    return stable(copy);
  });
};

const label = (frame) => frame.method ?? (frame.id !== undefined ? `reply ${frame.id}` : "?");

/** Paths of the leaf values that differ. */
const diffPaths = (a, b, path = "") => {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((v, i) => diffPaths(v, b[i], `${path}[${i}]`));
  }
  return [{ path: path || "<root>", ts: a, rust: b }];
};

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? "<absent>" : s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

let unexplained = 0;
const report = [];
for (const scenario of plan) {
  const tsCalls = JSON.parse(NodeFS.readFileSync(NodePath.join(scenario.dir, "ts/calls.json"), "utf8"));
  const tsEnv = JSON.parse(NodeFS.readFileSync(NodePath.join(scenario.dir, "ts/env.json"), "utf8"));
  const rustEnvPath = NodePath.join(scenario.dir, "rust/env.json");
  const rustEnv = NodeFS.existsSync(rustEnvPath) ? JSON.parse(NodeFS.readFileSync(rustEnvPath, "utf8")) : {};
  const ts = processes(readLog(NodePath.join(scenario.dir, "ts/stub.ndjson")));
  const rs = processes(readLog(NodePath.join(scenario.dir, "rust/stub.ndjson")));
  const diffs = [];
  const add = (kind, detail) => diffs.push({ kind, ...detail });

  if (ts.length !== rs.length) add("process-count", { ts: ts.length, rust: rs.length });
  for (let p = 0; p < Math.min(ts.length, rs.length); p += 1) {
    const a = ts[p];
    const b = rs[p];
    if (JSON.stringify(a.start.argv) !== JSON.stringify(b.start.argv)) {
      add("argv", { process: p, ts: a.start.argv, rust: b.start.argv });
    }
    const da = envDelta(a.start.env, tsEnv);
    const db = envDelta(b.start.env, rustEnv);
    for (const key of [...new Set([...Object.keys(da), ...Object.keys(db)])].sort()) {
      if (HOST_NOISE.test(key)) continue;
      if (da[key] !== db[key]) add("env", { process: p, key, ts: da[key], rust: db[key] });
    }
    const fa = normalizeFrames(a.frames);
    const fb = normalizeFrames(b.frames);
    // Align by method: walk both lists; a frame with no counterpart is extra or missing.
    let i = 0;
    let j = 0;
    while (i < fa.length || j < fb.length) {
      const x = fa[i];
      const y = fb[j];
      if (x && y && label(x) === label(y)) {
        for (const d of diffPaths(x.params ?? x.result, y.params ?? y.result)) {
          add("frame", { process: p, method: label(x), index: i, ...d });
        }
        i += 1;
        j += 1;
      } else if (y && (!x || fa.slice(i).every((f) => label(f) !== label(y)))) {
        add("rust-only-frame", { process: p, method: label(y), frame: y });
        j += 1;
      } else if (x) {
        add("ts-only-frame", { process: p, method: label(x), frame: x });
        i += 1;
      }
    }
    // Shutdown: the same steps in the same order, each within 500 ms of the other side's.
    const steps = (end) => end.map((e) => e.kind).join(" > ");
    const late = a.end.some((e, k) => e.afterMs !== undefined && b.end[k]?.afterMs !== undefined && Math.abs(e.afterMs - b.end[k].afterMs) > 500);
    if (steps(a.end) !== steps(b.end) || late) {
      const show = (end) => end.map((e) => (e.afterMs === undefined ? e.kind : `${e.kind}@${e.afterMs}ms`)).join(" > ");
      add("shutdown", { process: p, ts: show(a.end), rust: show(b.end) });
    }
  }
  // Answers of rollbackThread and forkThread, in call order.
  const tsResults = tsCalls.log.filter((e) => e.kind === "result");
  const rustResultsPath = NodePath.join(scenario.dir, "rust/results.json");
  const rustResults = NodeFS.existsSync(rustResultsPath) ? JSON.parse(NodeFS.readFileSync(rustResultsPath, "utf8")) : [];
  if (tsResults.length !== rustResults.length) {
    add("result-count", { ts: tsResults.map((r) => r.method), rust: rustResults.map((r) => r.method) });
  }
  tsResults.forEach((r, k) => {
    const theirs = rustResults[k];
    if (theirs === undefined) return;
    // The snapshot's rows: TS returns empty lists; the Rust side reports their lengths.
    const ours =
      r.method === "rollbackThread"
        ? { providerThread: r.output.providerThread, providerTurns: r.output.providerTurns.length, messages: r.output.messages.length, runtimeRequests: r.output.runtimeRequests.length }
        : r.output;
    for (const d of diffPaths(stable(ours), stable(theirs.output))) add("result", { method: r.method, ...d });
  });
  for (const d of diffs) {
    const known = KNOWN.find((k) => (k.scenario == null || k.scenario === scenario.name) && k.match(d));
    d.known = known?.reason;
    if (!known) unexplained += 1;
  }
  report.push({ scenario: scenario.name, covers: scenario.covers, tsOk: tsCalls.ok, tsFailure: tsCalls.failure, processes: [ts.length, rs.length], frames: [ts.reduce((n, p) => n + p.frames.length, 0), rs.reduce((n, p) => n + p.frames.length, 0)], diffs });
}

for (const r of report) {
  const open = r.diffs.filter((d) => !d.known).length;
  console.log(
    `\n== ${r.scenario} (${r.covers}): ${r.processes[0]}/${r.processes[1]} processes, ${r.frames[0]}/${r.frames[1]} frames (TS/Rust), ${r.diffs.length - open} known, ${open} open`,
  );
  if (!r.tsOk) console.log(`   note: the TS fixture assertions failed: ${String(r.tsFailure).split("\n")[0]}`);
  for (const d of r.diffs) {
    const tag = d.known ? "known" : "OPEN ";
    const where = d.kind === "frame" || d.kind === "result" ? `${d.method} ${d.path}` : d.kind === "env" ? d.key : (d.method ?? "");
    const values =
      d.kind === "rust-only-frame" || d.kind === "ts-only-frame" ? short(d.frame.params ?? d.frame.result ?? null) : `ts=${short(d.ts)} rust=${short(d.rust)}`;
    console.log(`   ${tag} ${d.kind} ${where}: ${values}${d.known ? ` (${d.known})` : ""}`);
  }
}
console.log(`\n${unexplained === 0 ? "ok" : "FAIL"}: ${unexplained} open difference(s) in ${report.length} scenario(s)`);
if (keep || unexplained > 0) console.log(`work folder: ${work}`);
else NodeFS.rmSync(work, { recursive: true, force: true });
process.exit(unexplained === 0 ? 0 : 1);

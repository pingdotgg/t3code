#!/usr/bin/env node
// Conformance check for the Codex launch and wire: does conn-provider-codex start
// `codex app-server` and write to it exactly as the T3 server's CodexAdapterV2 does?
//
//   node crates/conn-provider-codex/tools/conformance.mjs [--keep] [scenario ...]
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

import * as NodeAssert from "node:assert/strict";
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
  device: { fixture: "simple", mcp: true, device: true, covers: "a turn whose MCP session has the device tools" },
  approval: { fixture: "tool_call_read_only_on_request", covers: "an approval and its answer" },
  login: {
    fixture: "simple",
    loginShell: true,
    covers:
      "PATH, __MISE_DIFF and JAVA_HOME from a stand-in login shell (os-jank.ts fixPath), and the codex found on that PATH",
  },
  // In full access T3 answers an MCP access prompt itself, so the asked case runs in
  // auto-accept-edits (the fixture's explicit approval and sandbox policy stay; the thread's
  // runtime mode is the fixture input's \`runtimeMode\`).
  elicitation: {
    fixture: "tool_call_read_only_on_request",
    derive: "elicitation",
    runtimeMode: "auto-accept-edits",
    covers: "an MCP form elicitation shown as an approval, and its answer",
  },
  elicitationFullAccess: {
    fixture: "tool_call_read_only_on_request",
    derive: "elicitation",
    dropApprovals: true,
    covers: "an MCP form elicitation that full access accepts without asking",
  },
  interrupt: { fixture: "turn_interrupt", covers: "an interrupt" },
  // Thread titles through Codex (`CodexTextGeneration.ts`): `codex mcp list --json`, then
  // `codex exec` with the prompt on stdin. TS runs T3's `generateThreadTitle`; Rust gets the
  // same prompt and schema and runs `CodexProvider::generate_text`.
  titleListed: {
    title: {
      message: "Fix the login redirect after a password reset",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-6-astra",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      launchArgs: "--profile work -c sandbox_mode=workspace-write --search --oss",
      mcpServers: [
        { name: "t3-code", enabled: true },
        { name: "dotted.name", enabled: true },
        { name: "off", enabled: false },
      ],
    },
    covers: "a title on a listed model: mcp list, exec argv, effort, service tier, MCP servers off, schema file",
  },
  titleFallback: {
    title: {
      message: "Why does the build fail on CI only?",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-9-unknown",
        options: [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "flex" }],
      },
      launchArgs: "",
      mcpServers: [],
    },
    covers: "a title on an unlisted model: the catalog's first model, the selection's options dropped",
  },
  subagentStop: {
    fixture: "subagent_v2",
    derive: "subagentStop",
    addInterrupt: true,
    covers: "Stop while a subagent's turn runs: turn/interrupt to the root, then the child",
  },
  // A subagent that ends after its root turn: T3 asks for a continuation (the wake) and runs
  // it as the next turn. Both sides' wake requests are compared, and the turn/start Codex gets.
  subagentWake: {
    fixture: "subagent_v2",
    derive: "subagentWake",
    appendSteps: [{ type: "await_run_status", targetRunIndex: 2, status: "completed" }],
    continuationWorker: true,
    covers: "a subagent that ends after its root turn: the wake request, and the turn/start of the wake turn",
  },
  // A background command that ends after its turn: T3 keeps the settled turn, shows the late
  // output and end, and wakes the agent (`codexBackgroundCommandDetail`).
  commandWake: {
    fixture: "command_output_streaming",
    derive: "commandWake",
    appendSteps: [{ type: "await_run_status", targetRunIndex: 2, status: "completed" }],
    continuationWorker: true,
    covers: "a command that ends after its turn: its late output and end, the wake request, the wake turn/start",
  },
  model: {
    fixture: "multi_turn",
    setModelBefore: { index: 1, model: "gpt-6-astra" },
    covers: "a model and effort change between turns",
  },
  attachment: { fixture: "simple", attachments: true, covers: "a turn with attachments" },
  // A `providerInstances` entry (`instance`: `config` over the scenario's binary and home, and
  // `environment`), applied as each server applies it: T3's createCodexAdapterV2, our
  // CodexConfig::with_instance. Sensitive values are fake.
  instanceSettings: {
    fixture: "simple",
    instance: {
      config: { launchArgs: "  --enable conn_feature -c model_verbosity=\"low\"  " },
      environment: [
        { name: "CONFORMANCE_PLAIN", value: "plain value" },
        { name: "CONFORMANCE_SENSITIVE", value: "conformance-sensitive-value", sensitive: true },
        { name: "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", value: "Instance Origin" },
      ],
    },
    covers: "an instance's launch args and environment (plain, sensitive, the originator overridden)",
  },
  instanceLaunchEnv: {
    fixture: "simple",
    instance: {
      config: { launchArgs: "--enable from_setting" },
      environment: [{ name: "T3CODE_CODEX_LAUNCH_ARGS", value: "--enable from_instance_env" }],
    },
    covers: "T3CODE_CODEX_LAUNCH_ARGS from the instance environment wins over the setting",
  },
  titleInstance: {
    title: {
      message: "Fix the login redirect after a password reset",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra", options: [] },
      launchArgs: "--profile work",
      mcpServers: [],
    },
    instance: {
      environment: [
        { name: "CONFORMANCE_SENSITIVE", value: "conformance-sensitive-value", sensitive: true },
        { name: "CONFORMANCE_PLAIN", value: "plain value" },
      ],
    },
    covers: "a title on an instance with its own environment (mcp list and exec get it)",
  },
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
    model: "gpt-5.4",
    // CODEX_READ_ONLY_NEVER_POLICY in ThreadFork.integration.test.ts, which made the recording.
    policy: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } },
    covers: "a native fork at an earlier turn",
  },
};

/**
 * Differences that are known and explained. `scenario` null means every scenario. `match`
 * gets a difference record and returns true when it is this one.
 */
const KNOWN = [
  {
    scenario: "fork",
    reason:
      "Conn Server opens one session per app thread; when the source thread's session closes while the fork's session still uses the process it unloads the source thread, as TS does for an idle thread (unloadThread). TS's single shared session stops the process without it at the end of the test",
    match: (d) =>
      (d.kind === "rust-only-frame" && d.method === "thread/unsubscribe") ||
      (d.kind === "recording-rust" && d.method === "extra thread/unsubscribe"),
  },
  {
    scenario: null,
    reason:
      "the fixture releases the first process by advancing the TS test clock 31 minutes, so its 2 s SIGKILL deadline passes at once (killed within 100 ms of SIGTERM); not a server behaviour",
    match: (d) =>
      d.kind === "shutdown" && d.process === 0 && /SIGTERM@\d+ms > killed@0ms$/.test(d.ts),
  },
];

// Every fixture variant in the T3 test kit that replays a Codex recording runs as
// `rec-<fixture>`, unchanged, and both sides' stdin frames are asserted against the
// recording's `expect_outbound` frames (normalized as the TS replay driver does).
const FIXTURE_INDEX = NodePath.join(
  MONOREPO,
  "apps/server/src/orchestration-v2/testkit/fixtures/index.ts",
);
{
  const index = NodeFS.readFileSync(FIXTURE_INDEX, "utf8");
  const re = /\.\/([\w-]+)\/codex_transcript\.ndjson/g;
  let m;
  while ((m = re.exec(index))) {
    const names = [...index.slice(0, m.index).matchAll(/\n    name: "([^"]+)"/g)];
    const fixture = names.at(-1)?.[1];
    if (fixture !== undefined) {
      SCENARIOS[`rec-${fixture}`] = { fixture, recording: true, covers: `recording ${m[1]}` };
    }
  }
}
SCENARIOS.resume.recording = true;
SCENARIOS.fork.recording = true;
// Recordings no fixture runner replays (their tests drive custom steps): not run.
const NOT_RUN = {
  delegated_task_status: "used by a delegated-task test with its own steps, not a fixture",
  thread_merge_back_siblings: "used by ThreadMergeBack.integration.test.ts with its own steps",
  queued_cancelled_while_active:
    "its steps hold recorded frames back with the replay gate; the stub has one, but neither conformance driver runs release_replay_gate steps (the engine fixture replay does)",
};
delete SCENARIOS["rec-queued_cancelled_while_active"];

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

// The Codex catalog both sides see: T3's snapshot models, and Codex's models_cache.json that
// the Rust provider reads from CODEX_HOME.
const TITLE_MODELS = [
  { slug: "gpt-6-luna", name: "GPT-6-Luna", isCustom: false, capabilities: null },
  { slug: "gpt-6-astra", name: "GPT-6-Astra", isCustom: false, capabilities: null },
];
NodeFS.writeFileSync(
  NodePath.join(codexHome, "models_cache.json"),
  JSON.stringify({
    models: TITLE_MODELS.map((m, priority) => ({ slug: m.slug, display_name: m.name, visibility: "list", priority })),
  }),
);

const wrapper = (dir, extra = {}) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const config = NodePath.join(dir, "stub-config.json");
  NodeFS.writeFileSync(
    config,
    JSON.stringify({
      transcript: NodePath.join(NodePath.dirname(dir), "transcript.json"),
      log: NodePath.join(dir, "stub.ndjson"),
      ...extra,
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

/**
 * T3's approval recording with its command approval swapped for an MCP form elicitation on
 * the same turn (no Codex recording has one). The answer both sides send is compared; the
 * recording expects T3's reply for the fixture's `approve_next_runtime_request`.
 */
function deriveElicitation(fixture, dir) {
  const source = NodePath.join(
    MONOREPO,
    `apps/server/src/orchestration-v2/testkit/fixtures/${fixture}/codex_transcript.ndjson`,
  );
  let swapped = 0;
  const lines = NodeFS.readFileSync(source, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const entry = JSON.parse(line);
      const frame = entry.frame;
      if (entry.type === "emit_inbound" && frame?.method === "item/commandExecution/requestApproval") {
        swapped += 1;
        entry.label = "mcpServer/elicitation/request";
        entry.frame = {
          method: "mcpServer/elicitation/request",
          id: frame.id,
          params: {
            threadId: frame.params.threadId,
            turnId: frame.params.turnId,
            serverName: "computer-use",
            mode: "form",
            message: "Allow ChatGPT to use Safari?",
            _meta: { persist: ["session", "always"] },
            requestedSchema: {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  oneOf: [
                    { const: "once", title: "Allow once" },
                    { const: "session", title: "Allow for this session" },
                  ],
                },
              },
              required: ["approval"],
            },
          },
        };
      } else if (entry.type === "expect_outbound" && entry.label === "item/commandExecution/requestApproval") {
        entry.label = "mcpServer/elicitation/request";
        entry.frame = { id: frame.id, result: { action: "accept", content: { approval: "once" } } };
      }
      return JSON.stringify(entry);
    });
  if (swapped !== 1) throw new Error(`${fixture}: expected one command approval to swap, found ${swapped}`);
  const file = NodePath.join(dir, "derived_transcript.ndjson");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

/**
 * T3's `subagent_v2` recording cut after the child's `turn/started`: Stop then sends
 * `turn/interrupt` to the root turn and to the running child turn (T3's `interruptTurn`
 * targets the lineage), and Codex ends both as interrupted. The two servers' frames are
 * compared; the recording holds the order T3 sends them in.
 */
function deriveSubagentStop(fixture, dir) {
  const source = NodePath.join(
    MONOREPO,
    `apps/server/src/orchestration-v2/testkit/fixtures/${fixture}/codex_transcript.ndjson`,
  );
  const entries = NodeFS.readFileSync(source, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const rootStart = entries.find((e) => e.type === "expect_outbound" && e.frame?.method === "turn/start");
  const rootThread = rootStart.frame.params.threadId;
  const turnStarts = entries.filter((e) => e.type === "emit_inbound" && e.frame?.method === "turn/started");
  const root = turnStarts.find((e) => e.frame.params.threadId === rootThread).frame.params;
  const child = turnStarts.find((e) => e.frame.params.threadId !== rootThread).frame.params;
  const cut = entries.findIndex((e) => e.type === "emit_inbound" && e.frame?.params === child) + 1;
  const ended = (params, completedAt) => ({
    type: "emit_inbound",
    label: "turn/completed",
    frame: {
      method: "turn/completed",
      params: {
        threadId: params.threadId,
        turn: { ...params.turn, items: [], itemsView: "notLoaded", status: "interrupted", error: null, completedAt },
      },
    },
  });
  const interrupt = (params, id) => [
    { type: "expect_outbound", label: "turn/interrupt", frame: { id, method: "turn/interrupt", params: { threadId: params.threadId, turnId: params.turn.id } } },
    { type: "emit_inbound", label: "turn/interrupt", frame: { id, result: {} } },
  ];
  const at = (root.turn.startedAt ?? 0) + 2;
  const lines = [
    ...entries.slice(0, cut),
    ...interrupt(root, 900),
    ...interrupt(child, 901),
    ended(child, at),
    ended(root, at),
    { type: "runtime_exit", status: "success" },
  ].map((e) => JSON.stringify(e));
  const file = NodePath.join(dir, "derived_transcript.ndjson");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

/**
 * T3's `subagent_v2` recording with the subagent ending after the root turn (as
 * `crates/conn-server/tools/idle-diff.mjs` derives it): the child's last status change and turn
 * end, and the root's subagent items that report them, move behind the root's `turn/completed`.
 * Then the wake turn: `simple`'s turn on the root thread.
 */
function deriveSubagentWake(fixture, dir) {
  return deriveWake(fixture, dir, (entries, rootId) => {
    const isChildDone = (e) => e.frame?.method === "turn/completed" && e.frame.params?.threadId !== rootId;
    const childDone = entries.findIndex(isChildDone);
    const rootDone = entries.findIndex((e) => e.frame?.method === "turn/completed" && e.frame.params?.threadId === rootId);
    if (childDone < 1 || rootDone < childDone) throw new Error("subagent_v2 changed shape");
    return (entry, i) => {
      const item = entry.frame?.params?.item?.type;
      return (
        i === childDone ||
        (i === childDone - 1 && entry.frame?.method === "thread/status/changed") ||
        (i > childDone &&
          i < rootDone &&
          entry.type === "emit_inbound" &&
          (item === "subAgentActivity" || item === "collabAgentToolCall"))
      );
    };
  });
}

/**
 * `command_output_streaming` with its command running past the turn: the command's output
 * deltas and its \`item/completed\` move behind the root's \`turn/completed\`; then the wake turn.
 */
function deriveCommandWake(fixture, dir) {
  return deriveWake(fixture, dir, (entries) => {
    const started = entries.find((e) => e.frame?.method === "item/started" && e.frame.params?.item?.type === "commandExecution");
    if (started === undefined) throw new Error(`${fixture} has no command`);
    const id = started.frame.params.item.id;
    return (entry) =>
      entry.type === "emit_inbound" &&
      ((entry.frame?.method === "item/commandExecution/outputDelta" && entry.frame.params?.itemId === id) ||
        (entry.frame?.method === "item/completed" && entry.frame.params?.item?.id === id));
  });
}

/**
 * A recording with the frames \`late\` picks moved behind the root's \`turn/completed\`, then
 * \`simple\`'s turn on the root thread as the wake turn.
 */
function deriveWake(fixture, dir, pickLate) {
  const read = (name) =>
    NodeFS.readFileSync(
      NodePath.join(MONOREPO, `apps/server/src/orchestration-v2/testkit/fixtures/${name}/codex_transcript.ndjson`),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  const entries = read(fixture);
  const rootId = entries.find((e) => e.frame?.result?.thread?.id)?.frame.result.thread.id;
  const isRootDone = (e) => e.frame?.method === "turn/completed" && e.frame.params?.threadId === rootId;
  const late = pickLate(entries, rootId);
  const moved = [];
  const kept = [];
  entries.forEach((entry, i) => (late(entry, i) ? moved : kept).push(entry));
  kept.splice(kept.findIndex(isRootDone) + 1, 0, ...moved);
  const simple = read("simple");
  const simpleId = simple.find((e) => e.frame?.result?.thread?.id)?.frame.result.thread.id;
  const from = simple.findIndex((e) => e.type === "expect_outbound" && e.frame?.method === "turn/start");
  const to = simple.findIndex((e) => e.frame?.method === "turn/completed");
  const wake = simple.slice(from, to + 1).map((entry) => JSON.parse(JSON.stringify(entry).split(simpleId).join(rootId)));
  const exit = kept.findIndex((e) => e.type === "runtime_exit");
  kept.splice(exit === -1 ? kept.length : exit, 0, ...wake);
  const file = NodePath.join(dir, "derived_transcript.ndjson");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(file, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

/** The executable name the `login` scenario starts: only the stand-in shell's PATH has it. */
const LOGIN_CODEX = "codex-conn-login";

/**
 * A stand-in login shell for one side: its profile sets PATH (a folder that holds only the
 * stub, as LOGIN_CODEX, then the system folders `printenv` needs), __MISE_DIFF and JAVA_HOME,
 * then it runs the command it was given (`-ilc <command>`). Named `sh`, so neither server adds
 * its DEBUG-trap prefix. The real `codex` can never be found by that name.
 */
function loginShell(sideDir) {
  const bin = NodePath.join(sideDir, "login-bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.copyFileSync(NodePath.join(sideDir, "codex"), NodePath.join(bin, LOGIN_CODEX));
  NodeFS.chmodSync(NodePath.join(bin, LOGIN_CODEX), 0o755);
  const path = `${bin}:/usr/bin:/bin`;
  const shell = NodePath.join(sideDir, "shell", "sh");
  NodeFS.mkdirSync(NodePath.dirname(shell), { recursive: true });
  NodeFS.writeFileSync(
    shell,
    [
      "#!/bin/sh",
      `PATH=${JSON.stringify(path)}; export PATH`,
      `__MISE_DIFF="conn-login-diff"; export __MISE_DIFF`,
      `JAVA_HOME="/conn-login/jdk"; export JAVA_HOME`,
      'for arg; do command="$arg"; done',
      'exec /bin/sh -c "$command"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { shell, path };
}

const plan = selected.map((name) => {
  const dir = NodePath.join(work, name);
  const scenario = SCENARIOS[name];
  const extra = scenario.title ? { mcpServers: scenario.title.mcpServers } : {};
  const tsCodex = wrapper(NodePath.join(dir, "ts"), extra);
  const rustCodex = wrapper(NodePath.join(dir, "rust"), extra);
  const login = scenario.loginShell
    ? { ts: loginShell(NodePath.join(dir, "ts")), rust: loginShell(NodePath.join(dir, "rust")) }
    : undefined;
  return {
    name,
    dir,
    ...scenario,
    ...(login
      ? {
          tsShell: login.ts.shell,
          rustShell: login.rust.shell,
          tsShellPath: login.ts.path,
          rustShellPath: login.rust.path,
        }
      : {}),
    ...(scenario.derive === "elicitation"
      ? { transcriptFile: deriveElicitation(scenario.fixture, dir) }
      : {}),
    ...(scenario.derive === "subagentStop"
      ? { transcriptFile: deriveSubagentStop(scenario.fixture, dir) }
      : {}),
    ...(scenario.derive === "subagentWake"
      ? { transcriptFile: deriveSubagentWake(scenario.fixture, dir) }
      : {}),
    ...(scenario.derive === "commandWake"
      ? { transcriptFile: deriveCommandWake(scenario.fixture, dir) }
      : {}),
    tsCodex: login ? LOGIN_CODEX : tsCodex,
    rustCodex: login ? LOGIN_CODEX : rustCodex,
  };
});
NodeFS.writeFileSync(
  NodePath.join(work, "plan.json"),
  JSON.stringify({ codexHome, attachmentsDir, titleModels: TITLE_MODELS, scenarios: plan }, null, 2),
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
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { fixPath } from "../../os-jank.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as CodexAdapterV2 from "../Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeReplayServerConfig } from "./ProviderReplayHarness.ts";
import { findReplayFixture, runReplayFixture } from "./ProviderReplayFixtures.ts";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { buildThreadTitlePrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";

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
  // Nothing asks the user (\`elicitationFullAccess\`): the fixture's approvals are not given.
  if (scenario.dropApprovals) steps = steps.filter((s: any) => s.type !== "approve_next_runtime_request");
  if (scenario.attachments) {
    const first = steps.findIndex((s: any) => s.type === "message");
    steps[first] = { ...steps[first], attachments };
  }
  // Stop the first run after its message (\`subagentStop\`).
  if (scenario.addInterrupt) steps = [...steps, { type: "interrupt", targetRunIndex: 1 }];
  if (scenario.appendSteps) steps = [...steps, ...scenario.appendSteps];
  if (scenario.setModelBefore) {
    let seen = -1;
    const at = steps.findIndex((s: any) => s.type === "message" && ++seen === scenario.setModelBefore.index);
    steps = [...steps.slice(0, at), { type: "set_model", model: scenario.setModelBefore.model }, ...steps.slice(at)];
  }
  return { ...base, ...(scenario.runtimeMode ? { runtimeMode: scenario.runtimeMode } : {}), steps };
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
        ...(scenario.device ? { capabilities: new Set(["device"]) } : {}),
      } as any),
    clear: () => Effect.void,
    recordHtmlRender: () => Effect.void,
    takeHtmlRender: () => Effect.succeed(undefined),
  } as any);

const harnessFor = (scenario: any, log: Array<unknown>) => {
  const factory = CodexAdapterV2.layerAppServerClientFactory.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(PortScanner.layerTest),
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
    if (!scenario.loginShell) {
      fs.writeFileSync(\`\${scenario.dir}/ts/env.json\`, JSON.stringify(process.env));
    }
    const registry = ProviderAdapterRegistry.layerFromAdaptersEffect(
      CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: scenario.instance?.environment ?? [],
        enabled: true,
        config: {
          ...DEFAULT_CODEX_SETTINGS,
          binaryPath: scenario.tsCodex,
          homePath: PLAN.codexHome,
          ...Schema.decodeSync(CodexSettings)(scenario.instance?.config ?? {}),
          ...(scenario.instance?.config?.binaryPath ? {} : { binaryPath: scenario.tsCodex }),
          ...(scenario.instance?.config?.homePath ? {} : { homePath: PLAN.codexHome }),
        },
      }).pipe(
        Effect.map((adapter) => [adapter]),
        // The adapter's wake requests, logged and passed on to the server's queue.
        Effect.provide(
          Layer.effect(
            ProviderContinuationRequests.ProviderContinuationRequests,
            Effect.gen(function* () {
              const real = yield* ProviderContinuationRequests.ProviderContinuationRequests;
              return {
                ...real,
                offer: (request: any) =>
                  Effect.sync(() => log.push({ kind: "continuation", request })).pipe(Effect.andThen(real.offer(request))),
              };
            }),
          ),
        ),
      ),
    ).pipe(
      Layer.provide(
        // The adapter reads PortDiscovery itself (T3's CodexAdapterV2.testkit gives layerTest).
        Layer.mergeAll(
          factory,
          serverConfig,
          NodeServices.layer,
          NodeCrypto.layer,
          IdAllocator.layer,
          PortScanner.layerTest,
        ),
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

// A describe block with no test fails, so each is made only when it has scenarios.
const titleScenarios = PLAN.scenarios.filter((s: any) => s.title);
const replayScenarios = PLAN.scenarios.filter((s: any) => !s.title);
if (titleScenarios.length > 0) describe("conn codex title conformance", () => {
  for (const scenario of titleScenarios) {
    it.effect(scenario.name, () => {
      const title = scenario.title;
      // What the Rust side gets: T3's own prompt and output schema for this message.
      const built = buildThreadTitlePrompt({ message: title.message });
      const request = { prompt: built.prompt, outputSchema: JSON.stringify(toJsonSchemaObject(built.outputSchema)) };
      fs.writeFileSync(scenario.dir + "/ts/env.json", JSON.stringify(process.env));
      return Effect.gen(function* () {
        // The Codex driver's processEnv: the instance's environment over the server's.
        const processEnv = yield* mergeProviderInstanceEnvironment(scenario.instance?.environment, process.env);
        const generation = yield* makeCodexTextGeneration(
          { ...DEFAULT_CODEX_SETTINGS, binaryPath: scenario.tsCodex, homePath: PLAN.codexHome, launchArgs: title.launchArgs },
          processEnv,
          Effect.succeed(PLAN.titleModels),
        );
        return yield* generation.generateThreadTitle({
          cwd: scenario.dir,
          message: title.message,
          modelSelection: title.modelSelection,
        });
      }).pipe(
        Effect.provide(
          ServerConfig.ServerConfig.layerTest(scenario.dir, { prefix: "conn-codex-title-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.exit,
        Effect.map((exit) => {
          fs.writeFileSync(
            scenario.dir + "/ts/calls.json",
            safeJson({
              ok: Exit.isSuccess(exit),
              failure: Exit.isSuccess(exit) ? null : String(exit.cause),
              request,
              log: [{ kind: "result", method: "generateThreadTitle", output: Exit.isSuccess(exit) ? exit.value : null }],
            }),
          );
        }),
      );
    }, 30_000);
  }
});

if (replayScenarios.length > 0) describe("conn codex conformance", () => {
  for (const scenario of replayScenarios) {
    it.effect(scenario.name, () => {
      const log: Array<unknown> = [];
      const fixture = findReplayFixture(scenario.fixture)!;
      // A recording without a Codex fixture entry (provider_thread_resume), or a scenario with
      // its own steps and recording, runs with the simple fixture's Codex settings and no
      // output assertions.
      const own =
        scenario.transcript === undefined && scenario.transcriptFile === undefined
          ? fixture.providers.find((p: any) => p.driver === "codex")
          : undefined;
      const recording = scenario.transcript ?? scenario.fixture;
      const driver =
        own ?? {
          ...findReplayFixture("simple")!.providers.find((p: any) => p.driver === "codex")!,
          recordedScenario: recording,
          transcriptFile: scenario.transcriptFile
            ? new URL(\`file://\${scenario.transcriptFile}\`)
            : new URL(\`./fixtures/\${recording}/codex_transcript.ndjson\`, import.meta.url),
          assertOutput: () => {},
        };
      const driverWithModel = {
        ...driver,
        ...(scenario.model ? { modelSelection: { ...driver.modelSelection, model: scenario.model } } : {}),
        ...(scenario.policy ? { runtimePolicyOverride: { ...driver.runtimePolicyOverride, ...scenario.policy } } : {}),
        ...(scenario.continuationWorker ? { runContinuationWorker: true } : {}),
      };
      // The \`login\` scenario: the server's start-up PATH fix with a stand-in login shell,
      // as \`server.ts\` runs it, then the scenario; the environment is put back after.
      const saved = { ...process.env };
      const prepare = scenario.loginShell
        ? Effect.sync(() => {
            fs.writeFileSync(\`\${scenario.dir}/ts/env.json\`, JSON.stringify(process.env));
            process.env.SHELL = scenario.tsShell;
          }).pipe(
            Effect.andThen(fixPath().pipe(Effect.provide(NodeServices.layer))),
            Effect.andThen(
              Effect.sync(() => {
                if (saved.SHELL === undefined) delete process.env.SHELL;
                else process.env.SHELL = saved.SHELL;
              }),
            ),
          )
        : Effect.void;
      const restore = Effect.sync(() => {
        if (!scenario.loginShell) return;
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      });
      return prepare.pipe(Effect.andThen(runReplayFixture({
        fixtureName: scenario.fixture,
        buildInput: () => changedInput(scenario, fixture.buildInput()),
        driver: driverWithModel,
        harness: harnessFor(scenario, log) as any,
        materializeWorkspace: (transcript, workspace) =>
          Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
      })), Effect.ensuring(restore)).pipe(
        Effect.timeout("25 seconds"),
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
  GUARD_IMPORT +
    TEST_SOURCE.replace("__PLAN__", JSON.stringify(NodePath.join(work, "plan.json"))),
);
let tsStatus;
try {
  tsStatus = NodeChildProcess.spawnSync("vp", ["test", "run", NodePath.relative(server, testFile)], {
    cwd: server,
    stdio: ["ignore", "inherit", "inherit"],
    // Sealed: T3's code and the stub it starts get a throwaway HOME and only what node needs.
    env: sealedNodeEnv(NodePath.join(work, "ts-env")),
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
  NodePath.join(repoRoot, "tools/cargo-runner"),
  [exampleBinary("conn-provider-codex", "conformance"), NodePath.join(work, "plan.json")],
  // The same sealed runner as cargo run gives the example and its stub a throwaway HOME.
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"], env: sealedNodeEnv(NodePath.join(work, "rust-env")) },
);
// A Rust call that failed is reported by the example and shows as a difference below.
const rustFailed = rust.status !== 0;
if (rustFailed) console.error(`the Rust side reported failures (exit ${rust.status}); comparing anyway`);

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
    if (entry.kind === "start") out.push({ start: entry, frames: [], childReads: [], extra: [], missing: [], end: [] });
    // An old stub can still log its shutdown after the resumed process starts.
    const current = out.find((p) => p.start.pid === entry.pid);
    if (current === undefined) continue;
    if (entry.kind === "in") current.frames.push(entry.frame ?? { invalid: entry.line });
    // A subagent's model read (the stub logs it as \`child-metadata\` right after its \`in\`):
    // both servers send it from a background task, so it is compared as a set, not in order.
    if (entry.kind === "child-metadata") {
      const at = current.frames.findLastIndex((f) => f.id === entry.frame.id && f.method === entry.frame.method);
      if (at !== -1) current.frames.splice(at, 1);
      current.childReads.push(entry.frame);
    }
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

NodeAssert.deepEqual(processes([
  { kind: "start", pid: 1 },
  { kind: "alive", pid: 1, afterMs: 208 },
  { kind: "start", pid: 2 },
  { kind: "alive", pid: 1, afterMs: 1904 },
  { kind: "alive", pid: 2, afterMs: 1903 },
]).map((p) => p.end.at(-1).afterMs), [1904, 1903]);

/**
 * T3's \`mergePathEntries\`: the login shell's entries first, then the server's own, each once.
 * In the \`login\` scenario a child PATH that is exactly that merge reads as one marker, so the
 * two sides compare equal although their stand-in folders and their own PATH differ.
 */
const mergePath = (preferred, inherited) => {
  const merged = [];
  for (const value of [preferred, inherited]) {
    for (const entry of (value ?? "").split(":").map((e) => e.trim())) {
      if (entry !== "" && !merged.includes(entry)) merged.push(entry);
    }
  }
  return merged.join(":");
};
const loginPath = (delta, shellPath, parent) => {
  if (shellPath === undefined || delta.PATH === undefined) return delta;
  if (delta.PATH === mergePath(shellPath, parent.PATH)) {
    return { ...delta, PATH: "<login shell PATH, then the server's PATH>" };
  }
  return delta;
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

/** `sameFrame` in the TS replay driver, as a comparable string: `normalizeReplayFrame`, then
 * `normalizeThreadRequest`, then `stableStringify`. */
const replayKey = (frame, ignoredConfigKeys) => {
  const handoff = (v) => {
    if (!v.startsWith("Context handoff (")) return v;
    const marker = "\n\nUser message:\n";
    const at = v.indexOf(marker);
    const head = v.indexOf(":\n");
    return head === -1 || at === -1 || head >= at ? v : `${v.slice(0, head + 2)}<dynamic-summary>${v.slice(at)}`;
  };
  const norm = (v) => {
    if (typeof v === "string") return handoff(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v === null || typeof v !== "object") return v;
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
    if (out.method === "initialize" && out.params?.clientInfo) {
      out.params = { ...out.params, clientInfo: { ...out.params.clientInfo, version: "<ignored>" } };
    }
    if (out.method === "turn/start" && out.params && typeof out.params === "object") {
      const p = { ...out.params };
      // As T3's normalizeReplayFrame (effect-codex-app-server replay.ts): recordings made before
      // full access kept MCP prompts say \`never\`; both shapes drop out.
      const fullAccessPolicy = JSON.stringify({
        granular: { mcp_elicitations: true, request_permissions: false, rules: false, sandbox_approval: false, skill_approval: false },
      });
      if (p.approvalPolicy === "never" || JSON.stringify(p.approvalPolicy) === fullAccessPolicy) delete p.approvalPolicy;
      if (p.sandboxPolicy?.type === "dangerFullAccess") delete p.sandboxPolicy;
      if (p.collaborationMode && typeof p.collaborationMode === "object") {
        const c = { ...p.collaborationMode };
        if (c.settings && typeof c.settings === "object") c.settings = { ...c.settings, developer_instructions: "<ignored>" };
        p.collaborationMode = c;
      }
      out.params = p;
    }
    return out;
  };
  let f = norm(frame);
  if (["thread/start", "thread/resume", "thread/fork"].includes(f?.method) && f.params && typeof f.params === "object") {
    const { cwd: _c, model: _m, config, ...params } = f.params;
    if (config && typeof config === "object") {
      const owned = Object.fromEntries(
        Object.entries(config).filter(
          ([k]) => k !== "mcp_servers" && !k.startsWith("mcp_servers.") && k !== "shell_environment_policy.set.T3CODE_THREAD_ID" && !ignoredConfigKeys.has(k),
        ),
      );
      f = { ...f, params: { ...params, config: owned } };
    } else f = { ...f, params };
  }
  return JSON.stringify(stable(f));
};

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

/**
 * A title scenario's CLI runs, comparable across sides: each command's argv (the schema and
 * output files as their T3 shape, `<tmp>/t3code-codex-<kind>-<pid>-XXXXXX/<12 hex>`),
 * environment change, folder, and for `exec` the stdin bytes and the schema file.
 */
const titleRuns = (log, sideEnv) => {
  const runs = [];
  const tmp = NodeOS.tmpdir().replace(/\/+$/, "");
  const shape = (value) => {
    const m = /^(.*)\/t3code-codex-(schema|output)-(\d+)-([A-Za-z0-9]{6})\/([0-9a-f]{12})$/.exec(value);
    if (m === null) return value;
    const base = NodeFS.realpathSync(m[1]) === NodeFS.realpathSync(tmp) ? "<tmp>" : m[1];
    // The digits are the server's process id, which differs by side.
    return `${base}/t3code-codex-${m[2]}-<pid>-XXXXXX/<12 hex>`;
  };
  for (const entry of log) {
    if (entry.kind === "start") {
      runs.push({
        argv: entry.argv.map(shape),
        env: envDelta(entry.env, sideEnv),
        cwd: entry.cwd,
      });
    } else if (entry.kind === "exec" && runs.length > 0) {
      Object.assign(runs.at(-1), { stdin: entry.stdin, schema: entry.schema, schemaName: entry.schemaName });
    } else if (entry.kind === "mcp-list" && runs.length > 0) {
      runs.at(-1).mcpList = true;
    }
  }
  return runs;
};

let unexplained = 0;
const report = [];
for (const scenario of plan) {
  if (scenario.title) {
    const tsCalls = JSON.parse(NodeFS.readFileSync(NodePath.join(scenario.dir, "ts/calls.json"), "utf8"));
    const tsEnv = JSON.parse(NodeFS.readFileSync(NodePath.join(scenario.dir, "ts/env.json"), "utf8"));
    const rustEnvPath = NodePath.join(scenario.dir, "rust/env.json");
    const rustEnv = NodeFS.existsSync(rustEnvPath) ? JSON.parse(NodeFS.readFileSync(rustEnvPath, "utf8")) : {};
    const rustResultsPath = NodePath.join(scenario.dir, "rust/results.json");
    const rustResults = NodeFS.existsSync(rustResultsPath) ? JSON.parse(NodeFS.readFileSync(rustResultsPath, "utf8")) : [];
    const ts = titleRuns(readLog(NodePath.join(scenario.dir, "ts/stub.ndjson")), tsEnv);
    const rs = titleRuns(readLog(NodePath.join(scenario.dir, "rust/stub.ndjson")), rustEnv);
    const diffs = [];
    if (ts.length !== rs.length) diffs.push({ kind: "process-count", ts: ts.length, rust: rs.length });
    for (let p = 0; p < Math.min(ts.length, rs.length); p += 1) {
      const a = ts[p];
      const b = rs[p];
      for (const key of ["argv", "cwd", "stdin", "schema", "schemaName", "mcpList"]) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diffs.push({ kind: "frame", method: `run ${p}`, path: key, ts: a[key], rust: b[key] });
      }
      for (const key of [...new Set([...Object.keys(a.env), ...Object.keys(b.env)])].sort()) {
        if (HOST_NOISE.test(key)) continue;
        if (a.env[key] !== b.env[key]) diffs.push({ kind: "env", process: p, key, ts: a.env[key], rust: b.env[key] });
      }
    }
    const tsOut = tsCalls.log.find((e) => e.kind === "result")?.output ?? null;
    const rsOut = rustResults[0]?.output ?? null;
    if (JSON.stringify(stable(tsOut)) !== JSON.stringify(stable(rsOut))) {
      diffs.push({ kind: "result", method: "generateThreadTitle", path: "<root>", ts: tsOut, rust: rsOut });
    }
    for (const d of diffs) {
      const known = KNOWN.find((k) => (k.scenario == null || k.scenario === scenario.name) && k.match(d));
      d.known = known?.reason;
      if (!known) unexplained += 1;
    }
    report.push({ scenario: scenario.name, covers: scenario.covers, tsOk: tsCalls.ok, tsFailure: tsCalls.failure, processes: [ts.length, rs.length], frames: [0, 0], diffs });
    continue;
  }
  const tsCalls = JSON.parse(NodeFS.readFileSync(NodePath.join(scenario.dir, "ts/calls.json"), "utf8"));
  const tsEnv = JSON.parse(NodeFS.readFileSync(NodePath.join(scenario.dir, "ts/env.json"), "utf8"));
  const rustEnvPath = NodePath.join(scenario.dir, "rust/env.json");
  const rustEnv = NodeFS.existsSync(rustEnvPath) ? JSON.parse(NodeFS.readFileSync(rustEnvPath, "utf8")) : {};
  const ts = processes(readLog(NodePath.join(scenario.dir, "ts/stub.ndjson")));
  const rs = processes(readLog(NodePath.join(scenario.dir, "rust/stub.ndjson")));
  const diffs = [];
  const add = (kind, detail) => diffs.push({ kind, ...detail });

  if (ts.length !== rs.length) add("process-count", { ts: ts.length, rust: rs.length });
  // Wake requests: T3's adapter's offers (logged by the TS side) against our
  // \`continuation.requested\` events, in order: text, notice and delivery.
  {
    const tsWakes = tsCalls.log
      .filter((e) => e.kind === "continuation")
      .map((e) => ({ detail: e.request.detail ?? null, notification: e.request.notification ?? null, delivery: e.request.delivery ?? null }));
    const rustEventsPath = NodePath.join(scenario.dir, "rust/events.json");
    const rustEvents = NodeFS.existsSync(rustEventsPath) ? JSON.parse(NodeFS.readFileSync(rustEventsPath, "utf8")) : [];
    const rustWakes = rustEvents
      .filter((e) => e.type === "continuation.requested")
      .map((e) => ({ detail: e.detail ?? null, notification: e.notification ?? null, delivery: e.delivery ?? null }));
    if (JSON.stringify(stable(tsWakes)) !== JSON.stringify(stable(rustWakes))) {
      add("continuation", { ts: tsWakes, rust: rustWakes });
    }
    if (scenario.continuationWorker && tsWakes.length === 0) add("continuation", { ts: "no wake", rust: rustWakes.length });
  }
  // The \`login\` scenario proves something only when each side found the stub through the
  // login shell's PATH and passed that shell's values on; equal failures must not pass.
  if (scenario.loginShell) {
    const expected = { PATH: "<login shell PATH, then the server's PATH>", __MISE_DIFF: "conn-login-diff" };
    for (const [side, list, env, shellPath] of [
      ["ts", ts, tsEnv, scenario.tsShellPath],
      ["rust", rs, rustEnv, scenario.rustShellPath],
    ]) {
      if (list.length === 0) {
        add("login-shell", { key: "codex", [side]: `${LOGIN_CODEX} not started` });
        continue;
      }
      const delta = loginPath(envDelta(list[0].start.env, env), shellPath, env);
      const want = { ...expected, ...(env.JAVA_HOME ? {} : { JAVA_HOME: "/conn-login/jdk" }) };
      for (const [key, value] of Object.entries(want)) {
        if (delta[key] !== value) {
          add("login-shell", { key, [side]: `${delta[key] ?? "<absent>"} (want ${value})` });
        }
      }
    }
  }
  for (let p = 0; p < Math.min(ts.length, rs.length); p += 1) {
    const a = ts[p];
    const b = rs[p];
    if (JSON.stringify(a.start.argv) !== JSON.stringify(b.start.argv)) {
      add("argv", { process: p, ts: a.start.argv, rust: b.start.argv });
    }
    const da = loginPath(envDelta(a.start.env, tsEnv), scenario.tsShellPath, tsEnv);
    const db = loginPath(envDelta(b.start.env, rustEnv), scenario.rustShellPath, rustEnv);
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
    // Child model reads: the same requests on both sides, in any order.
    const reads = (list) => list.map(({ id: _id, ...frame }) => JSON.stringify(stable(frame))).sort();
    if (JSON.stringify(reads(a.childReads)) !== JSON.stringify(reads(b.childReads))) {
      add("child-reads", { process: p, ts: reads(a.childReads), rust: reads(b.childReads) });
    }
    // Shutdown: the same steps in the same order, each within 500 ms of the other side's.
    const steps = (end) => end.map((e) => e.kind).join(" > ");
    const late = a.end.some((e, k) => e.afterMs !== undefined && b.end[k]?.afterMs !== undefined && Math.abs(e.afterMs - b.end[k].afterMs) > 500);
    if (steps(a.end) !== steps(b.end) || late) {
      const show = (end) => end.map((e) => (e.afterMs === undefined ? e.kind : `${e.kind}@${e.afterMs}ms`)).join(" > ");
      add("shutdown", { process: p, ts: show(a.end), rust: show(b.end) });
    }
  }
  if (scenario.recording) {
    const recorded = JSON.parse(NodeFS.readFileSync(NodePath.join(scenario.dir, "transcript.json"), "utf8"));
    const ignored = new Set(recorded.metadata?.recorderThreadConfigKeys ?? []);
    const expectations = [[]];
    for (const entry of recorded.entries) {
      if (entry.type === "runtime_exit") expectations.push([]);
      if (entry.type === "expect_outbound") expectations.at(-1).push(entry.frame);
    }
    for (const [side, procs] of [["ts", ts], ["rust", rs]]) {
      let matched = 0;
      let total = 0;
      procs.forEach((proc, p) => {
        const want = expectations[p] ?? [];
        total += want.length;
        const n = Math.max(want.length, proc.frames.length);
        for (let k = 0; k < n; k += 1) {
          const a = want[k] === undefined ? undefined : replayKey(want[k], ignored);
          const b = proc.frames[k] === undefined ? undefined : replayKey(proc.frames[k], ignored);
          if (a !== undefined && a === b) {
            matched += 1;
            continue;
          }
          add(`recording-${side}`, {
            process: p,
            method: want[k] === undefined ? `extra ${label(proc.frames[k])}` : label(want[k]),
            index: k,
            ...(diffPaths(JSON.parse(a ?? "null"), JSON.parse(b ?? "null"))[0] ?? {}),
          });
          break;
        }
      });
      scenario[`recording_${side}`] = `${matched}/${total}`;
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
  report.push({ scenario: scenario.name, recording: scenario.recording ? `${scenario.recording_ts} TS, ${scenario.recording_rust} Rust` : undefined, covers: scenario.covers, tsOk: tsCalls.ok, tsFailure: tsCalls.failure, processes: [ts.length, rs.length], frames: [ts.reduce((n, p) => n + p.frames.length, 0), rs.reduce((n, p) => n + p.frames.length, 0)], diffs });
}

for (const r of report) {
  const open = r.diffs.filter((d) => !d.known).length;
  console.log(
    `\n== ${r.scenario} (${r.covers}): ${r.processes[0]}/${r.processes[1]} processes, ${r.frames[0]}/${r.frames[1]} frames (TS/Rust)${r.recording ? `, recorded frames matched: ${r.recording}` : ""}, ${r.diffs.length - open} known, ${open} open`,
  );
  if (!r.tsOk) console.log(`   note: the TS fixture assertions failed: ${String(r.tsFailure).split("\n")[0]}`);
  for (const d of r.diffs) {
    const tag = d.known ? "known" : "OPEN ";
    const where = d.kind === "frame" || d.kind === "result" ? `${d.method} ${d.path}` : d.kind === "env" || d.kind === "login-shell" ? d.key : (d.method ?? "");
    const values =
      d.kind === "rust-only-frame" || d.kind === "ts-only-frame" ? short(d.frame.params ?? d.frame.result ?? null) : `ts=${short(d.ts)} rust=${short(d.rust)}`;
    console.log(`   ${tag} ${d.kind} ${where}: ${values}${d.known ? ` (${d.known})` : ""}`);
  }
}
for (const [name, reason] of Object.entries(NOT_RUN)) console.log(`\nnot run: ${name}: ${reason}`);
console.log(`\n${unexplained === 0 ? "ok" : "FAIL"}: ${unexplained} open difference(s) in ${report.length} scenario(s)`);
if (keep || unexplained > 0) console.log(`work folder: ${work}`);
else NodeFS.rmSync(work, { recursive: true, force: true });
process.exit(unexplained === 0 ? 0 : 1);

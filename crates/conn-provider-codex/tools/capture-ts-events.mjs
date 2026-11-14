#!/usr/bin/env node
// Regenerates testdata/cli and testdata/ts from the Conn monorepo at CONN_MONOREPO (after
// `vp i`): `node crates/conn-provider-codex/tools/capture-ts-events.mjs [name ...]`. Offline: it
// replays recorded transcripts, no model is called. It adds one temporary test to
// apps/server/src/orchestration-v2/testkit, named with this run's PID so runs side by side on
// one checkout do not collide, and deletes it on exit.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo } from "../../../tools/monorepo.mjs";

const MONOREPO = monorepo();
const CRATE = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const FIXTURES = [
  "simple",
  "multi_turn",
  "codex_model_reroute",
  "queued_turn",
  "message_steering",
  "turn_interrupt",
  "turn_interrupt_mid_tool",
  "command_output_streaming",
  "tool_call_workspace_never",
  "tool_call_read_only_on_request",
  "tool_call_restricted_granular",
  "web_search",
  "todo_list",
  "plan_questions",
  "proposed_plan",
  "subagent",
  "subagent_continue",
  "subagent_v2",
  "subagent_v2_approval",
  "subagent_v2_nested",
  "subagent_v2_nested_approval",
];

const TEST_SOURCE = `
import * as fs from "node:fs";
import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

const OUT = __OUT__;
const tapped = (log: Array<unknown>) => ({
  ...CodexOrchestratorReplayHarness,
  makeProviderAdapterRegistryLayer: (transcript: any, options?: any) =>
    Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const ctx = yield* Layer.build(
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, options),
        );
        const registry = ctx.mapUnsafe.get(ProviderAdapterRegistry.ProviderAdapterRegistryV2.key) as any;
        return {
          ...registry,
          get: (id: any) =>
            registry.get(id).pipe(
              Effect.map((adapter: any) => ({
                ...adapter,
                openSession: (input: any) =>
                  adapter.openSession(input).pipe(
                    Effect.map((runtime: any) => {
                      const wrap = (method: string) => (callInput: any) => {
                        log.push({ kind: "call", method, input: callInput });
                        return runtime[method](callInput);
                      };
                      return {
                        ...runtime,
                        events: runtime.events.pipe(
                          Stream.tap((event: any) => Effect.sync(() => log.push({ kind: "event", event }))),
                        ),
                        startTurn: wrap("startTurn"),
                        respondToRuntimeRequest: wrap("respondToRuntimeRequest"),
                      };
                    }),
                  ),
              })),
            ),
        };
      }),
    ),
});

describe("conn codex capture", () => {
  itRunsReplayFixtures("codex", (input) => {
    const log: Array<unknown> = [];
    return runReplayFixture({
      ...input,
      harness: tapped(log) as any,
      materializeWorkspace: (transcript, workspace) =>
        Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => fs.writeFileSync(\`\${OUT}/\${input.fixtureName}.json\`, JSON.stringify(log))),
      ),
    );
  });
});
`;

const names = process.argv.length > 2 ? process.argv.slice(2) : FIXTURES;
const server = NodePath.join(MONOREPO, "apps/server");
const testkit = NodePath.join(server, "src/orchestration-v2/testkit");
const testFile = NodePath.join(testkit, `ConnCodexCapture.${process.pid}.tmp.test.ts`);
const cleanup = () => NodeFS.rmSync(testFile, { force: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}
const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-codex-capture-"));
const head = NodeChildProcess.execFileSync("git", ["-C", MONOREPO, "rev-parse", "--short", "HEAD"])
  .toString()
  .trim();
const capturedOn = new Date().toISOString().slice(0, 10);

// Vitest workers do not inherit the environment, so the output folder goes into the source.
NodeFS.writeFileSync(testFile, TEST_SOURCE.replace("__OUT__", JSON.stringify(out)));
try {
  NodeChildProcess.execFileSync("vp", ["test", "run", NodePath.relative(server, testFile)], {
    cwd: server,
    stdio: "inherit",
  });
} finally {
  cleanup();
}

for (const name of names) {
  const log = JSON.parse(NodeFS.readFileSync(NodePath.join(out, `${name}.json`), "utf8"));
  const golden = {
    note: `ProviderAdapterV2 calls and events from CodexAdapterV2 (TS) replaying cli/${name}.ndjson through the orchestrator fixture runner at ${head}; driver dropped.`,
    capturedOn,
    startTurn: log.filter((e) => e.kind === "call" && e.method === "startTurn").map((e) => e.input),
    respond: log
      .filter((e) => e.kind === "call" && e.method === "respondToRuntimeRequest")
      .map((e) => e.input),
    events: log
      .filter((e) => e.kind === "event")
      .map(({ event }) => {
        const { driver: _driver, ...rest } = event;
        return rest;
      }),
  };
  NodeFS.writeFileSync(
    NodePath.join(CRATE, "testdata/ts", `${name}.json`),
    `${JSON.stringify(golden, null, 2)}\n`,
  );
  NodeFS.copyFileSync(
    NodePath.join(testkit, "fixtures", name, "codex_transcript.ndjson"),
    NodePath.join(CRATE, "testdata/cli", `${name}.ndjson`),
  );
  console.log(`${name}: ${golden.events.length} events`);
}
NodeFS.rmSync(out, { recursive: true, force: true });

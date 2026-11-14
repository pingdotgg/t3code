#!/usr/bin/env node
// Regenerates testdata/<flavor>/*.json from the Conn monorepo at CONN_MONOREPO (after `vp i`):
//
//   CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/capture-ts-events.mjs <flavor> [fixture ...]
//
// <flavor> is grok, kiro, fx or acpRegistry. Offline: it replays the T3 test kit's recorded
// ACP transcripts through T3's own fixture runner and adapter; no agent starts, no model is
// called. It adds one temporary test to apps/server/src/orchestration-v2/testkit and deletes it.
//
// Each golden file holds, for one fixture:
// - `transcript`: the entries exactly as T3's harness handed them to its replay agent, after
//   `materializeReplayTranscriptRuntimeInstructions` (the runtime notes T3 appends to prompts);
// - `calls`: every ProviderAdapterV2 session call the orchestrator made (`openSession`,
//   `ensureThread`, `startTurn`, ...) with its input, in order, and the value it returned;
// - `events`: every ProviderAdapterV2Event the adapter emitted, `driver` dropped;
// - `outcome`: `passed` or the T3 test's own failure text.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo } from "../../../tools/monorepo.mjs";

const HARNESSES = {
  grok: { name: "GrokOrchestratorReplayHarness", file: "GrokAdapterV2.testkit.ts", transcript: "grok_transcript.ndjson" },
  kiro: { name: "KiroOrchestratorReplayHarness", file: "KiroAdapterV2.testkit.ts", transcript: "kiro_transcript.ndjson" },
  fx: { name: "FxOrchestratorReplayHarness", file: "FxAdapterV2.testkit.ts", transcript: "fx_transcript.ndjson" },
  acpRegistry: {
    name: "AcpRegistryOrchestratorReplayHarness",
    file: "AcpRegistryAdapterV2.testkit.ts",
    transcript: "registry_transcript.ndjson",
  },
};

const [flavor, ...only] = process.argv.slice(2);
const harness = HARNESSES[flavor];
if (harness === undefined) {
  console.error(`usage: capture-ts-events.mjs <${Object.keys(HARNESSES).join("|")}> [fixture ...]`);
  process.exit(2);
}

const MONOREPO = monorepo();
const CRATE = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const TEST_SOURCE = `
import * as fs from "node:fs";
import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ${harness.name} as HARNESS } from "../Adapters/${harness.file}";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

const OUT = __OUT__;
const ONLY: ReadonlyArray<string> = __ONLY__;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));

const tapped = (log: Array<unknown>, transcripts: Array<unknown>) => ({
  ...HARNESS,
  makeProviderAdapterRegistryLayer: (transcript: any, options?: any) => {
    transcripts.push(plain(transcript));
    return Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const ctx = yield* Layer.build(HARNESS.makeProviderAdapterRegistryLayer(transcript, options));
        const registry = ctx.mapUnsafe.get(ProviderAdapterRegistry.ProviderAdapterRegistryV2.key) as any;
        return {
          ...registry,
          get: (id: any) =>
            registry.get(id).pipe(
              Effect.map((adapter: any) => ({
                ...adapter,
                openSession: (input: any) => {
                  log.push({ kind: "call", method: "openSession", input: plain(input) });
                  return adapter.openSession(input).pipe(
                    Effect.map((runtime: any) => {
                      const wrapped: Record<string, unknown> = { ...runtime };
                      for (const [key, value] of Object.entries(runtime)) {
                        if (typeof value !== "function") continue;
                        wrapped[key] = (callInput: any, ...rest: Array<any>) => {
                          const entry: any = { kind: "call", method: key, input: plain(callInput) };
                          log.push(entry);
                          const result = (value as any)(callInput, ...rest);
                          return Effect.isEffect(result)
                            ? (result as any).pipe(
                                Effect.onExit((exit: any) =>
                                  Effect.sync(() => {
                                    entry.exit = Exit.isSuccess(exit)
                                      ? { ok: plain(exit.value) }
                                      : { error: String(exit.cause) };
                                  }),
                                ),
                              )
                            : result;
                        };
                      }
                      wrapped.events = runtime.events.pipe(
                        Stream.tap((event: any) => Effect.sync(() => log.push({ kind: "event", event: plain(event) }))),
                      );
                      if (Effect.isEffect(runtime.close)) {
                        wrapped.close = Effect.sync(() => log.push({ kind: "call", method: "close" })).pipe(
                          Effect.andThen(runtime.close),
                        );
                      }
                      return wrapped;
                    }),
                  );
                },
              })),
            ),
        };
      }),
    );
  },
});

describe("conn acp capture", () => {
  itRunsReplayFixtures("${flavor}", (input) => {
    if (ONLY.length > 0 && !ONLY.includes(input.fixtureName)) return Effect.void;
    const log: Array<unknown> = [];
    const transcripts: Array<unknown> = [];
    return runReplayFixture({ ...input, harness: tapped(log, transcripts) as any }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() =>
          fs.writeFileSync(
            \`\${OUT}/\${input.fixtureName}.json\`,
            JSON.stringify({
              outcome: Exit.isSuccess(exit) ? "passed" : String(exit.cause),
              transcripts,
              log,
            }),
          ),
        ),
      ),
      Effect.flatten,
    );
  });
});
`;

const server = NodePath.join(MONOREPO, "apps/server");
const testkit = NodePath.join(server, "src/orchestration-v2/testkit");
const testFile = NodePath.join(testkit, `ConnAcpCapture${flavor}.tmp.test.ts`);
const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-acp-capture-"));
const head = NodeChildProcess.execFileSync("git", ["-C", MONOREPO, "rev-parse", "--short", "HEAD"])
  .toString()
  .trim();
const capturedOn = new Date().toISOString().slice(0, 10);

// Vitest workers do not inherit the environment, so the output folder goes into the source.
NodeFS.writeFileSync(
  testFile,
  TEST_SOURCE.replace("__OUT__", JSON.stringify(out)).replace("__ONLY__", JSON.stringify(only)),
);
let status = 0;
try {
  NodeChildProcess.execFileSync("vp", ["test", "run", NodePath.relative(server, testFile)], {
    cwd: server,
    stdio: "inherit",
  });
} catch {
  // Failing T3 cases are recorded with their outcome, not dropped.
  status = 1;
} finally {
  NodeFS.rmSync(testFile, { force: true });
}

const target = NodePath.join(CRATE, "testdata", flavor);
NodeFS.mkdirSync(target, { recursive: true });
for (const file of NodeFS.readdirSync(out).toSorted()) {
  const name = file.replace(/\.json$/, "");
  const raw = JSON.parse(NodeFS.readFileSync(NodePath.join(out, file), "utf8"));
  const golden = {
    note: `ProviderAdapterV2 calls and events from T3's ${flavor} adapter replaying fixtures/${name}/${harness.transcript} through the orchestrator fixture runner at ${head}; driver dropped.`,
    capturedOn,
    outcome: raw.outcome,
    transcripts: raw.transcripts.map((t) => t.entries),
    calls: raw.log.filter((e) => e.kind === "call").map(({ kind: _k, ...rest }) => rest),
    events: raw.log
      .filter((e) => e.kind === "event")
      .map(({ event }) => {
        const { driver: _driver, ...rest } = event;
        return rest;
      }),
  };
  NodeFS.writeFileSync(NodePath.join(target, `${name}.json`), `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`${name}: ${golden.outcome === "passed" ? "passed" : "T3 FAILED"}, ${golden.calls.length} calls, ${golden.events.length} events`);
}
NodeFS.rmSync(out, { recursive: true, force: true });
process.exit(status);

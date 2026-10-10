// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// The SDK's host factory is Promise-based and owns a raw child process, as production's does.
/**
 * Records a Muse MSP replay transcript by running a registered fixture's input
 * through the real orchestrator and the real MuseAdapterV2 against a live
 * `muse serve`. The host's stdio is teed line by line.
 *
 *   node scripts/record-muse-msp-replay-fixture.ts --scenario simple
 *
 * Uses the machine's own `muse login`. `T3_MUSE_BIN` picks the binary. The
 * recording replays itself through the fixture's assertions before it is
 * written, so a run that fails them never replaces the existing transcript.
 */
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createUuidV7Mint } from "@muse-code/sdk";
import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import {
  connectMuseTransport,
  layer as museReplayLayer,
  materializeMuseReplayWorkspace,
  MUSE_MSP_REPLAY_PROTOCOL,
  MUSE_PROVIDER_KIND,
  museRecordLabel,
  MuseOrchestratorReplayHarness,
} from "../src/orchestration-v2/Adapters/MuseAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeMuseEnvironment,
  museLaunch,
  museServeArgs,
  museWorkspaceRoot,
  parseMuseVersion,
} from "@t3tools/provider-muse/testing";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  checkpointWorkspace,
  makeCheckpointWorkspace,
} from "@t3tools/provider-testing/replayWorkspace";

const CLOCK_TICK = Duration.millis(20);

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenario = readArgValue("--scenario");
const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenario);
const variant = fixture?.providers.find((provider) => provider.driver === MUSE_PROVIDER_KIND);
if (fixture === undefined || variant === undefined) {
  const names = ORCHESTRATOR_REPLAY_FIXTURES.filter((entry) =>
    entry.providers.some((provider) => provider.driver === MUSE_PROVIDER_KIND),
  ).map((entry) => entry.name);
  throw new Error(`Pass --scenario with a fixture that registers Muse: ${names.join(", ")}`);
}

const museBinary = process.env.T3_MUSE_BIN ?? "muse";
// Started as T3 starts it, so Windows needs no T3_MUSE_BIN for Muse's `muse.cmd` launcher.
const museStart = Effect.runSync(museLaunch(museBinary));
const home = process.env.HOME ?? "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Makes a recording portable: the workspace becomes `<workspace>` and the home
 * directory `~`, in both directions. Ids, timestamps and model output are kept
 * as recorded; they are opaque to T3 and carry no secrets.
 */
function normalizeEntries(
  entries: ReadonlyArray<ProviderReplayEntry>,
  workspaces: ReadonlyArray<string>,
): ReadonlyArray<ProviderReplayEntry> {
  const normalizeString = (value: string): string => {
    let next = value;
    for (const workspace of workspaces) next = next.replaceAll(workspace, "<workspace>");
    return home.length > 1 ? next.replaceAll(home, "~") : next;
  };
  const normalizeValue = (value: unknown): unknown =>
    typeof value === "string"
      ? normalizeString(value)
      : Array.isArray(value)
        ? value.map(normalizeValue)
        : isRecord(value)
          ? Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]),
            )
          : value;
  return entries.map((entry) =>
    entry.type === "runtime_exit" ? entry : { ...entry, frame: normalizeValue(entry.frame) },
  );
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function encodeTranscriptNdjson(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    encodeJson({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => encodeJson(entry)),
    "",
  ].join("\n");
}

/** Recording follows wall time so a live Muse's own timeouts still elapse. */
const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

/**
 * Host factory that runs a live `muse serve` and tees every stdio line into
 * `entries`, in the order the connection writes and reads them.
 */
function makeRecordingCreateHost(
  entries: Array<ProviderReplayEntry>,
  commandIds: Array<Array<string>>,
): Parameters<typeof museReplayLayer>[0]["createHost"] {
  return async (options) => {
    const hostOrdinal = commandIds.length + 1;
    const minted: Array<string> = [];
    commandIds.push(minted);
    const mint = createUuidV7Mint();
    const args = museServeArgs(options);
    const clientRequests = new Map<unknown, string>();
    const serverRequests = new Map<unknown, string>();
    const record = (type: "expect_outbound" | "emit_inbound", frame: unknown) => {
      const label = museRecordLabel(
        frame,
        type,
        type === "emit_inbound" ? clientRequests : serverRequests,
        hostOrdinal,
      );
      entries.push({ type, ...(label === undefined ? {} : { label }), frame });
    };
    record("expect_outbound", { type: "host_start", args });
    // The binary named by T3_MUSE_BIN, so the recorded version matches what ran.
    const child = NodeChildProcess.spawn(museStart.command, [...museStart.args, ...args], {
      cwd: options.cwd,
      env: options.environment ?? makeMuseEnvironment(),
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = new Promise<{ code: number | null; signal: null }>((resolve) =>
      child.once("exit", (code) => resolve({ code, signal: null })),
    );
    async function* incoming() {
      let buffer = "";
      // utf8 decoding keeps a character split across chunks intact.
      for await (const chunk of child.stdout.setEncoding("utf8")) {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const frame: unknown = JSON.parse(line);
          if (isRecord(frame) && typeof frame.method === "string" && "id" in frame)
            serverRequests.set(frame.id, frame.method);
          record("emit_inbound", frame);
          yield `${line}\n`;
        }
      }
    }
    const close = async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    };
    return connectMuseTransport({
      transport: {
        incoming: incoming(),
        write: async (line) => {
          for (const part of line.split("\n")) {
            if (!part.trim()) continue;
            const frame: unknown = JSON.parse(part);
            if (isRecord(frame) && typeof frame.method === "string" && "id" in frame)
              clientRequests.set(frame.id, frame.method);
            record("expect_outbound", frame);
          }
          await new Promise<void>((resolve, reject) =>
            child.stdin.write(line, (error) => (error ? reject(error) : resolve())),
          );
        },
        close: () => void close(),
      },
      readOnly: options.readOnly,
      mintCommandId: () => {
        const id = mint();
        minted.push(id);
        return id;
      },
      exited,
      close,
    });
  };
}

const readMuseVersion = Effect.sync(() => {
  const output = NodeChildProcess.execFileSync(
    museStart.command,
    [...museStart.args, "--version"],
    { encoding: "utf8" },
  );
  return parseMuseVersion(output) ?? output.trim();
});

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const museVersion = yield* readMuseVersion;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const fixtureInput = fixture.buildInput();
  const workspace = yield* Effect.promise(() =>
    makeCheckpointWorkspace(`muse-msp-record-${fixture.name}`, fixtureInput.workspaceFiles),
  );
  yield* Effect.addFinalizer(() =>
    fs.remove(workspace, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  const canonicalWorkspace = yield* fs.realPath(workspace);

  const entries: Array<ProviderReplayEntry> = [];
  const commandIds: Array<Array<string>> = [];
  const placeholder = {
    provider: MUSE_PROVIDER_KIND,
    protocol: MUSE_MSP_REPLAY_PROTOCOL,
    version: museVersion,
    scenario: fixture.name,
    entries: [],
  } satisfies ProviderReplayTranscript;
  const materializeInput = materializeFixtureInput({
    scenario: fixture.name,
    fixtureInput,
    driver: variant.driver,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer));
  const continuationOptions =
    variant.runContinuationWorker === true ? { runContinuationWorker: true } : {};

  yield* Effect.gen(function* () {
    yield* followWallClock.pipe(Effect.forkScoped);
    const materialized = yield* materializeInput;
    yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/muse:record`,
        transcript: placeholder,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
      },
      {
        driver: MuseOrchestratorReplayHarness.driver,
        decodeTranscript: Effect.succeed,
        makeProviderAdapterRegistryLayer: () =>
          museReplayLayer({
            scenario: fixture.name,
            createHost: makeRecordingCreateHost(entries, commandIds),
            environment: makeMuseEnvironment(),
          }),
      },
      continuationOptions,
    );
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  const transcript = {
    ...placeholder,
    metadata: {
      generatedBy: "live-muse-recorder",
      model: variant.modelSelection.model,
      commandIds,
    },
    // The verbatim root first: it contains the canonical path.
    entries: normalizeEntries(entries, [
      yield* museWorkspaceRoot(canonicalWorkspace),
      canonicalWorkspace,
      workspace,
    ]),
  } satisfies ProviderReplayTranscript;

  yield* Effect.gen(function* () {
    const replayWorkspace = yield* checkpointWorkspace(fixture.name, fixtureInput.workspaceFiles);
    const materialized = yield* materializeInput;
    const replayResult = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/muse:verify`,
        transcript: yield* MuseOrchestratorReplayHarness.decodeTranscript(
          yield* materializeMuseReplayWorkspace(transcript, replayWorkspace),
        ),
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: replayWorkspace },
      },
      MuseOrchestratorReplayHarness,
      continuationOptions,
    );
    variant.assertOutput(replayResult, transcript);
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
  yield* Console.log(`Wrote ${transcript.entries.length} Muse MSP replay entries to ${outputPath}`);
});

await Effect.runPromise(record.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

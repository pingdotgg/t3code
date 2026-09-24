/**
 * Records a Pi RPC replay transcript by running a registered fixture's input
 * through the real orchestrator and the real PiAdapterV2 against a live
 * `pi --mode rpc`. The adapter's spawner tees every stdin/stdout record.
 *
 *   node scripts/record-pi-rpc-replay-fixture.ts --scenario simple
 *
 * The model is pinned to the fixture's Pi model selection (a cheap OpenRouter
 * model) through launch arguments and `set_model`. Sessions go to a temporary
 * directory, never the user's Pi session store.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  makePiProviderAdapterRegistryLayer,
  makePiRecordingSpawner,
  PI_REPLAY_ANY,
  PI_RPC_REPLAY_PROTOCOL,
} from "../src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts";
import { PI_PROVIDER } from "../src/orchestration-v2/Adapters/PiAdapterV2.ts";
import { layer as idAllocatorLayer } from "../src/orchestration-v2/IdAllocator.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeCheckpointWorkspace } from "../src/orchestration-v2/testkit/ReplayFixtureWorkspace.ts";

/** Keeps the user's skills, templates and context files out of the recording. */
const HERMETIC_LAUNCH_ARGS = "--no-extensions --no-skills --no-prompt-templates --no-context-files";
const CLOCK_TICK = Duration.millis(20);

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenario = readArgValue("--scenario");
const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenario);
const variant = fixture?.providers.find((provider) => provider.driver === PI_PROVIDER);
if (fixture === undefined || variant === undefined) {
  const names = ORCHESTRATOR_REPLAY_FIXTURES.filter((entry) =>
    entry.providers.some((provider) => provider.driver === PI_PROVIDER),
  ).map((entry) => entry.name);
  throw new Error(`Pass --scenario with a fixture that registers Pi: ${names.join(", ")}`);
}

const piBinary = process.env.T3_PI_BIN ?? "pi";
const [modelProvider, ...modelId] = variant.modelSelection.model.split("/");
const launchArgs = `--provider ${modelProvider} --model ${modelId.join("/")} ${HERMETIC_LAUNCH_ARGS}`;
const home = process.env.HOME ?? "";

// ── normalization ─────────────────────────────────────────────

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
/** Recorded wall-clock times are shifted to start here, keeping their spacing. */
const NORMALIZED_EPOCH_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Makes a live recording portable and reviewable. Session files, the
 * workspace, the home directory, UUIDs and wall-clock times become stable
 * placeholders applied consistently to both directions, so values the adapter
 * echoes back (a session path in `switch_session`, `--fork <file>`) still line
 * up on replay. Opaque reasoning signatures are dropped, and the model catalog
 * is trimmed to the pinned model: the adapter only reads context windows there.
 */
function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly sessionDir: string;
  readonly modelSlug: string;
}): ReadonlyArray<ProviderReplayEntry> {
  const sessionFiles = new Map<string, string>();
  const uuids = new Map<string, string>();
  let timeAnchorMs: number | undefined;
  const shiftTime = (ms: number): number => {
    timeAnchorMs ??= ms;
    return NORMALIZED_EPOCH_MS + (ms - timeAnchorMs);
  };
  const sessionFilePattern = new RegExp(
    `${escapeRegExp(input.sessionDir)}/[^\\s"']+?\\.jsonl`,
    "gu",
  );
  const normalizeString = (value: string): string =>
    value
      .replace(sessionFilePattern, (file) => {
        const existing = sessionFiles.get(file);
        if (existing !== undefined) return existing;
        const next = `/pi-sessions/session-${sessionFiles.size + 1}.jsonl`;
        sessionFiles.set(file, next);
        return next;
      })
      .replaceAll(input.sessionDir, "/pi-sessions")
      .replaceAll(input.workspace, "<workspace>")
      .replaceAll(home.length > 1 ? home : "\0", "~")
      .replace(ISO_TIMESTAMP_PATTERN, (iso) =>
        DateTime.formatIso(
          DateTime.makeUnsafe(shiftTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)))),
        ),
      )
      .replace(UUID_PATTERN, (uuid) => {
        const existing = uuids.get(uuid.toLowerCase());
        if (existing !== undefined) return existing;
        const next = `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`;
        uuids.set(uuid.toLowerCase(), next);
        return next;
      });
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (!isRecord(value)) return value;
    // Pi's system prompt lists the machine's skills, docs and cwd, and the
    // adapter never reads system messages. Keep the shape, drop the text.
    if (value.role === "system" && isRecord(value.sections)) {
      return {
        ...value,
        sections: Object.fromEntries(
          Object.keys(value.sections).map((key) => [key, "<system-prompt-section>"]),
        ),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "thinkingSignature" || key === "textSignature"
          ? "<signature>"
          : key === "timestamp" && typeof entry === "number"
            ? shiftTime(entry)
            : normalizeValue(entry),
      ]),
    );
  };
  const normalizeFrame = (frame: unknown): unknown => {
    if (!isRecord(frame)) return normalizeValue(frame);
    const args = frame.args;
    if (frame.type === "process_start" && Array.isArray(args)) {
      // The injected extension lives in the server's per-run cache directory.
      return normalizeValue({
        ...frame,
        args: args.map((arg, index) => (args[index - 1] === "--extension" ? PI_REPLAY_ANY : arg)),
      });
    }
    const data = frame.data;
    if (frame.command === "get_available_models" && isRecord(data) && Array.isArray(data.models)) {
      return normalizeValue({
        ...frame,
        data: {
          ...data,
          models: data.models.filter(
            (model) => isRecord(model) && `${model.provider}/${model.id}` === input.modelSlug,
          ),
        },
      });
    }
    return normalizeValue(frame);
  };
  return input.entries.map((entry) =>
    entry.type === "runtime_exit" ? entry : { ...entry, frame: normalizeFrame(entry.frame) },
  );
}

function encodeTranscriptNdjson(transcript: ProviderReplayTranscript): string {
  const { entries, ...metadata } = transcript;
  return [
    JSON.stringify({ type: "transcript_start", ...metadata }),
    ...entries.map((entry) => JSON.stringify(entry)),
    "",
  ].join("\n");
}

// ── recording run ─────────────────────────────────────────────

/**
 * Replay runs on a frozen TestClock; recording shares that runtime so fixture
 * `advance_clock` steps behave identically, but lets it follow wall time so a
 * live Pi's timeouts and termination grace periods still elapse.
 */
const followWallClock = Effect.gen(function* () {
  while (true) {
    yield* TestClock.withLive(Effect.sleep(CLOCK_TICK));
    yield* TestClock.adjust(CLOCK_TICK);
  }
});

const readPiVersion = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return (yield* spawner.string(ChildProcess.make(piBinary, ["--version"]))).trim();
});

const record = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const piVersion = yield* readPiVersion;
  const outputPath = readArgValue("--out") ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const workspace = yield* Effect.promise(() =>
    makeCheckpointWorkspace(`pi-rpc-record-${fixture.name}`),
  );
  const sessionDir = yield* fs.makeTempDirectory({ prefix: `t3-pi-record-sessions-` });
  yield* Effect.addFinalizer(() =>
    Effect.all([
      fs.remove(workspace, { recursive: true, force: true }),
      fs.remove(sessionDir, { recursive: true, force: true }),
    ]).pipe(Effect.ignore),
  );

  const entries: Array<ProviderReplayEntry> = [];
  const placeholder = {
    provider: PI_PROVIDER,
    protocol: PI_RPC_REPLAY_PROTOCOL,
    version: piVersion,
    scenario: fixture.name,
    entries: [],
  } satisfies ProviderReplayTranscript;
  const recordingSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(Effect.service(ChildProcessSpawner.ChildProcessSpawner), (live) =>
      makePiRecordingSpawner(live, entries),
    ),
  ).pipe(Layer.provide(NodeServices.layer));

  const result = yield* Effect.gen(function* () {
    yield* followWallClock.pipe(Effect.forkScoped);
    const materialized = yield* materializeFixtureInput({
      scenario: fixture.name,
      fixtureInput: fixture.buildInput(),
      driver: variant.driver,
      modelSelection: variant.modelSelection,
    }).pipe(Effect.provide(idAllocatorLayer));
    return yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: `${fixture.name}/pi:record`,
        transcript: placeholder,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
        runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: workspace },
      },
      {
        driver: PI_PROVIDER,
        decodeTranscript: Effect.succeed,
        makeProviderAdapterRegistryLayer: () =>
          makePiProviderAdapterRegistryLayer({
            scenario: fixture.name,
            binaryPath: piBinary,
            launchArgs,
            environment: [
              { name: "PI_CODING_AGENT_SESSION_DIR", value: sessionDir, sensitive: false },
              { name: "PI_SKIP_VERSION_CHECK", value: "1", sensitive: false },
            ],
            spawner: recordingSpawner,
          }),
      },
      variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
    );
  }).pipe(Effect.scoped, provideDeterministicTestRuntime);

  const transcript = {
    ...placeholder,
    metadata: {
      generatedBy: "live-pi-recorder",
      piVersion,
      model: variant.modelSelection.model,
      launchArgs,
    },
    entries: normalizeEntries({
      entries,
      workspace,
      sessionDir,
      modelSlug: variant.modelSelection.model,
    }),
  } satisfies ProviderReplayTranscript;
  yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
  yield* fs.writeFileString(outputPath, encodeTranscriptNdjson(transcript));
  yield* Console.log(`Wrote ${transcript.entries.length} Pi RPC replay entries to ${outputPath}`);
  // The live run must already satisfy the fixture's assertions; replay proves it again.
  variant.assertOutput(result, transcript);
});

await Effect.runPromise(record.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

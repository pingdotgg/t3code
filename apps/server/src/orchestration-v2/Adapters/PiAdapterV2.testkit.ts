/**
 * Pi RPC replay: swaps the `ChildProcessSpawner` that `PiAdapterV2` uses to
 * spawn `pi --mode rpc` for one that answers from a recorded transcript. The
 * real adapter and `PiRpc` framing run unchanged against recorded Pi output.
 *
 * Transcript entries are stdio records. `expect_outbound` is one JSONL record
 * the adapter wrote to stdin and `emit_inbound` is one record Pi wrote to
 * stdout. Pi echoes the adapter's request ids, so a recorded id is rebound to
 * the id the replaying adapter actually sent. `<any>` in an outbound frame
 * matches any value.
 *
 * Every spawned Pi process begins with a synthetic `process_start` outbound
 * record carrying its argv. Records of the Nth process (N > 1) carry an `@pN`
 * label suffix, because a native fork runs a short-lived `--fork` process
 * next to the session process.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderReplayEntry,
  type ProviderInstanceEnvironment,
  type ProviderReplayTranscript,
  type ProviderReplayEntry as ProviderReplayEntryType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterDriverCreateError } from "../ProviderAdapterDriver.ts";
import { makeDriverLayer as makeProviderAdapterRegistryDriverLayer } from "../ProviderAdapterRegistry.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import { PI_PROVIDER, PiAdapterV2Driver } from "./PiAdapterV2.ts";

export const PI_RPC_REPLAY_PROTOCOL = "pi.rpc-jsonl";
export const PI_REPLAY_ANY = "<any>";

const PiRpcReplayTranscript = Schema.Struct({
  provider: Schema.Literal(PI_PROVIDER),
  protocol: Schema.Literal(PI_RPC_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type PiRpcReplayTranscript = typeof PiRpcReplayTranscript.Type;
const decodePiRpcReplayTranscript = Schema.decodeUnknownEffect(PiRpcReplayTranscript);

class PiReplayTranscriptDecodeError extends Schema.TaggedError<PiReplayTranscriptDecodeError>()(
  "PiReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode Pi RPC replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

class PiReplayMismatchError extends Schema.TaggedError<PiReplayMismatchError>()(
  "PiReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    process: Schema.Number,
    label: Schema.optional(Schema.String),
    actualType: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Pi replay frame mismatch at cursor ${this.cursor} (expected ${this.label ?? "<none>"}, received ${this.actualType ?? "<untyped>"} from process ${this.process}) in scenario ${this.scenario}.`;
  }
}

class PiReplayIncompleteError extends Schema.TaggedError<PiReplayIncompleteError>()(
  "PiReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    nextLabel: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Pi replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} (next ${this.nextLabel ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

/** Label or, failing that, entry type: bounded context for a replay error. */
function entryLabel(entry: ProviderReplayEntryType | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.type === "runtime_exit" ? "runtime_exit" : (entry.label ?? entry.type);
}

const PiOrchestratorReplayHarnessError = Schema.Union([
  PiReplayTranscriptDecodeError,
  ProviderAdapterDriverCreateError,
]);
type PiOrchestratorReplayHarnessError = typeof PiOrchestratorReplayHarnessError.Type;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === PI_REPLAY_ANY) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

/** PiRpc numbers its correlated requests `t3-N` per process. */
const ADAPTER_REQUEST_ID = /^t3-\d+$/u;

function adapterRequestId(frame: unknown): string | undefined {
  const id = isRecord(frame) ? frame.id : undefined;
  return typeof id === "string" && ADAPTER_REQUEST_ID.test(id) ? id : undefined;
}

/**
 * Compares a recorded request against the adapter's own request id, so the
 * correlation Pi recorded holds without pinning counter values. Any other id,
 * such as the Pi request id an `extension_ui_response` must echo, stays exact.
 */
function withRequestId(expected: unknown, actual: unknown): unknown {
  const actualId = adapterRequestId(actual);
  return isRecord(expected) && adapterRequestId(expected) !== undefined && actualId !== undefined
    ? { ...expected, id: actualId }
    : expected;
}

/** A write may not match past one of these: it would be a turn early. */
function startsTurn(entry: ProviderReplayEntryType): boolean {
  if (entry.type !== "expect_outbound") return false;
  const type = isRecord(entry.frame) ? entry.frame.type : undefined;
  return type === "prompt" || type === "compact" || type === "process_start";
}

function processStartFrame(command: ChildProcess.Command) {
  const args = ChildProcess.isStandardCommand(command) ? command.args : [];
  return { type: "process_start", args: [...args] };
}

/** `response:get_state@p2` belongs to the second spawned process; no suffix is the first. */
function entryProcess(entry: ProviderReplayEntryType): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@p(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}

function recordLabel(frame: unknown, process: number): string | undefined {
  const base = !isRecord(frame)
    ? undefined
    : frame.type === "response" && typeof frame.command === "string"
      ? `response:${frame.command}`
      : typeof frame.type === "string"
        ? frame.type
        : undefined;
  if (base === undefined || process === 1) return base;
  return `${base}@p${process}`;
}

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Splits a byte stream into LF-delimited records, as Pi's RPC framing requires. */
function makeLineSplitter() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): ReadonlyArray<string> => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
  };
}

interface PiReplayProcess {
  readonly ordinal: number;
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
  /** Recorded request id -> id the replaying adapter sent in its place. */
  readonly ids: Map<string, string>;
  open: boolean;
}

/**
 * Drives every Pi process of one scenario from a single ordered transcript.
 * Outbound records must match the recording; the inbound records that follow
 * them are written to the stdout of the process that produced them.
 *
 * Independent adapter fibers (skill discovery beside thread setup, a settle
 * probe beside a steer) can reach stdin in a different order than recorded, so
 * a write that matches a later outbound record of the same turn is held until
 * the transcript reaches it. A write that matches nothing before the next
 * turn-starting record fails immediately.
 */
class PiReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly consumed = new Set<number>();
  private readonly held: Array<{ readonly process: PiReplayProcess; readonly actual: unknown }> =
    [];
  private readonly processes: Array<PiReplayProcess> = [];
  private readonly transcript: PiRpcReplayTranscript;

  constructor(transcript: PiRpcReplayTranscript) {
    this.transcript = transcript;
  }

  spawn(
    command: ChildProcess.Command,
    stdout: Queue.Queue<Uint8Array, Cause.Done>,
  ): PiReplayProcess {
    const process: PiReplayProcess = {
      ordinal: this.processes.length + 1,
      stdout,
      ids: new Map(),
      open: true,
    };
    this.processes.push(process);
    this.receive(process, processStartFrame(command));
    return process;
  }

  receive(process: PiReplayProcess, actual: unknown): void {
    if (this.failure !== null) return;
    const entries = this.transcript.entries;
    let possible = false;
    for (let index = this.cursor; index < entries.length && !possible; index += 1) {
      const entry = entries[index]!;
      const pending = entry.type === "expect_outbound" && !this.consumed.has(index);
      possible =
        pending &&
        entryProcess(entry) === process.ordinal &&
        replayValueMatches(withRequestId(entry.frame, actual), actual);
      if (!possible && pending && startsTurn(entry)) break;
    }
    if (!possible) {
      const expected = entries[this.cursor];
      const label = entryLabel(expected);
      const actualType = isRecord(actual) ? actual.type : undefined;
      this.fail(
        new PiReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          process: process.ordinal,
          ...(label === undefined ? {} : { label }),
          ...(typeof actualType === "string" ? { actualType } : {}),
          expected: expected ?? null,
          actual,
        }),
      );
      return;
    }
    this.held.push({ process, actual });
    this.advance();
  }

  /** The adapter released a process: its scope closed. */
  close(process: PiReplayProcess): void {
    process.open = false;
    Queue.endUnsafe(process.stdout);
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length || this.held.length > 0) {
      const nextLabel = entryLabel(this.transcript.entries[this.cursor]);
      throw new PiReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
        ...(nextLabel === undefined ? {} : { nextLabel }),
      });
    }
  }

  /** Emits due inbound records and consumes held writes until neither can progress. */
  private advance(): void {
    let progressed = true;
    while (progressed && this.failure === null) {
      progressed = this.drainInbound();
      for (const [heldIndex, write] of this.held.entries()) {
        if (this.consumePending(write.process, write.actual)) {
          this.held.splice(heldIndex, 1);
          progressed = true;
          break;
        }
      }
    }
  }

  /** Matches a write against the outbound records due before the next inbound one. */
  private consumePending(process: PiReplayProcess, actual: unknown): boolean {
    const entries = this.transcript.entries;
    for (let index = this.cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "expect_outbound") return false;
      if (this.consumed.has(index) || entryProcess(entry) !== process.ordinal) continue;
      if (!replayValueMatches(withRequestId(entry.frame, actual), actual)) continue;
      const recordedId = adapterRequestId(entry.frame);
      const actualId = adapterRequestId(actual);
      if (recordedId !== undefined && actualId !== undefined) {
        process.ids.set(recordedId, actualId);
      }
      this.consumed.add(index);
      while (this.consumed.has(this.cursor)) this.cursor += 1;
      return true;
    }
    return false;
  }

  private drainInbound(): boolean {
    let emitted = false;
    while (this.failure === null) {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "runtime_exit") {
        // Pi exited on its own in the recording: end the newest process's
        // stdout, which is the EOF the adapter observed.
        this.cursor += 1;
        emitted = true;
        const process = this.processes.at(-1);
        if (process !== undefined) this.close(process);
        continue;
      }
      if (entry?.type !== "emit_inbound") return emitted;
      const process = this.processes[entryProcess(entry) - 1];
      if (process === undefined) return emitted;
      this.cursor += 1;
      emitted = true;
      // Output a process wrote after the adapter released it was never observed.
      if (!process.open) continue;
      const frame = entry.frame;
      const recordedId = isRecord(frame) ? frame.id : undefined;
      const reboundId = typeof recordedId === "string" ? process.ids.get(recordedId) : undefined;
      const rebound =
        isRecord(frame) && reboundId !== undefined ? { ...frame, id: reboundId } : frame;
      Queue.offerUnsafe(process.stdout, new TextEncoder().encode(`${encodeJsonLine(rebound)}\n`));
    }
    return emitted;
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    for (const process of this.processes) Queue.endUnsafe(process.stdout);
  }
}

/** Deliberately outside the valid pid range so PiRpc's group kill never lands. */
const REPLAY_PID = 999_999_999;

function makePiReplaySpawner(
  controller: PiReplayController,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const process = controller.spawn(command, yield* Queue.unbounded<Uint8Array, Cause.Done>());
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.close(process)));
      const split = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(REPLAY_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            for (const line of split(chunk)) controller.receive(process, decodeJsonLine(line));
          }),
        ),
        stdout: Stream.fromQueue(process.stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

/**
 * Registry with the real Pi driver on the given spawner. The recorder passes a
 * spawner that tees a live `pi`; replay passes the transcript-backed one. The
 * launch arguments are part of the recorded argv, so replay reuses them.
 */
export function makePiProviderAdapterRegistryLayer<E, R>(input: {
  readonly scenario: string;
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, E, R>;
  readonly binaryPath: string;
  readonly launchArgs: string;
  readonly environment?: ProviderInstanceEnvironment;
}) {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(`pi-${input.scenario}`).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return makeProviderAdapterRegistryDriverLayer({
    drivers: [PiAdapterV2Driver],
    configMap: {
      [PI_PROVIDER]: {
        driver: PI_PROVIDER,
        enabled: true,
        config: { binaryPath: input.binaryPath, launchArgs: input.launchArgs },
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      },
    },
  }).pipe(
    Layer.provide(input.spawner),
    Layer.provide(Layer.mergeAll(serverConfigLayer, NodeServices.layer, IdAllocator.layer)),
  );
}

function metadataString(transcript: PiRpcReplayTranscript, key: string): string {
  const value = transcript.metadata?.[key];
  return typeof value === "string" ? value : "";
}

export const PiOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  PiRpcReplayTranscript,
  PiOrchestratorReplayHarnessError
> = {
  driver: PI_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodePiRpcReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new PiReplayTranscriptDecodeError({
            driver: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    makePiProviderAdapterRegistryLayer({
      scenario: transcript.scenario,
      binaryPath: "pi",
      launchArgs: metadataString(transcript, "launchArgs"),
      spawner: Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const controller = new PiReplayController(transcript);
          yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
          return makePiReplaySpawner(controller);
        }),
      ),
    }),
};

// ── recording ─────────────────────────────────────────────────

/**
 * Wraps a live spawner and tees every Pi process's stdin and stdout records
 * into `entries` in the order the adapter observed them: writes as the adapter
 * makes them, reads as the adapter pulls them.
 */
export function makePiRecordingSpawner(
  live: ChildProcessSpawner.ChildProcessSpawner["Service"],
  entries: Array<ProviderReplayEntryType>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  let spawned = 0;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* live.spawn(command);
      const process = ++spawned;
      const record = (type: "expect_outbound" | "emit_inbound", frame: unknown) => {
        const label = recordLabel(frame, process);
        entries.push({ type, ...(label === undefined ? {} : { label }), frame });
      };
      const recordLines = (
        type: "expect_outbound" | "emit_inbound",
        lines: ReadonlyArray<string>,
      ) => {
        for (const line of lines) {
          try {
            record(type, decodeJsonLine(line));
          } catch {
            // PiRpc drops non-JSON stdout lines, so the transcript does too.
          }
        }
      };
      record("expect_outbound", processStartFrame(command));
      const splitIn = makeLineSplitter();
      const splitOut = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        ...handle,
        stdin: handle.stdin.pipe(
          Sink.mapInput((chunk: Uint8Array) => {
            recordLines("expect_outbound", splitIn(chunk));
            return chunk;
          }),
        ),
        stdout: handle.stdout.pipe(
          Stream.tap((chunk) => Effect.sync(() => recordLines("emit_inbound", splitOut(chunk)))),
        ),
      });
    }),
  );
}

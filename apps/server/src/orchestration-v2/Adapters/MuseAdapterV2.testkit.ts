import * as NodeServices from "@effect/platform-node/NodeServices";
import { Connection, type DuplexTransport } from "@muse-code/sdk";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderReplayEntry,
  type ProviderReplayEntry as ProviderReplayEntryType,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import { MuseSettings } from "@t3tools/provider-muse/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  museInitializeParams,
  museServeArgs,
  museWorkspaceRoot,
  type MuseSdkHost,
  type MuseSdkHostOptions,
} from "@t3tools/provider-muse/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { makeMuseAdapterV2 } from "@t3tools/provider-muse/server";

export const MUSE_PROVIDER_KIND = "muse";
export const MUSE_MSP_REPLAY_PROTOCOL = "muse.msp-jsonl";
const MUSE_REPLAY_ANY = "<any>";

const MuseReplayTranscript = Schema.Struct({
  provider: Schema.Literal(MUSE_PROVIDER_KIND),
  protocol: Schema.Literal(MUSE_MSP_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.Struct({
    commandIds: Schema.Array(Schema.Array(Schema.String)),
  }),
  entries: Schema.Array(ProviderReplayEntry),
});
type MuseReplayTranscript = typeof MuseReplayTranscript.Type;
const decodeMuseReplayTranscript = Schema.decodeUnknownEffect(MuseReplayTranscript);

class MuseReplayTranscriptDecodeError extends Schema.TaggedError<MuseReplayTranscriptDecodeError>()(
  "MuseReplayTranscriptDecodeError",
  { scenario: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to decode Muse MSP replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

class MuseReplayMismatchError extends Schema.TaggedError<MuseReplayMismatchError>()(
  "MuseReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    host: Schema.Number,
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Muse replay frame mismatch at cursor ${this.cursor} from host ${this.host} in scenario ${this.scenario}.`;
  }
}

class MuseReplayIncompleteError extends Schema.TaggedError<MuseReplayIncompleteError>()(
  "MuseReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    nextLabel: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Muse replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} (next ${this.nextLabel ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === MUSE_REPLAY_ANY) return true;
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

function clientRequestId(frame: unknown): number | undefined {
  return isRecord(frame) && typeof frame.method === "string" && typeof frame.id === "number"
    ? frame.id
    : undefined;
}

function withRequestId(expected: unknown, actual: unknown): unknown {
  const actualId = clientRequestId(actual);
  return isRecord(expected) && clientRequestId(expected) !== undefined && actualId !== undefined
    ? { ...expected, id: actualId }
    : expected;
}

/** A write may not match past one of these: it would be a turn early. */
function startsTurn(entry: ProviderReplayEntryType): boolean {
  if (entry.type !== "expect_outbound" || !isRecord(entry.frame)) return false;
  const method = entry.frame.method ?? entry.frame.type;
  return method === "turn/start" || method === "session/compact" || method === "host_start";
}

function entryHost(entry: ProviderReplayEntryType): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@h(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}

function entryLabel(entry: ProviderReplayEntryType | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.type === "runtime_exit" ? "runtime_exit" : (entry.label ?? entry.type);
}

export function museRecordLabel(
  frame: unknown,
  direction: "expect_outbound" | "emit_inbound",
  requestMethods: ReadonlyMap<unknown, string>,
  host: number,
): string | undefined {
  if (!isRecord(frame)) return undefined;
  const method = typeof frame.method === "string" ? frame.method : undefined;
  const base =
    frame.type === "host_start"
      ? "host_start"
      : method !== undefined
        ? direction === "emit_inbound" && "id" in frame
          ? `request:${method}`
          : method
        : requestMethods.has(frame.id)
          ? `${direction === "emit_inbound" ? "response" : "reply"}:${requestMethods.get(frame.id)}`
          : undefined;
  return base === undefined || host === 1 ? base : `${base}@h${host}`;
}

class LineQueue implements AsyncIterable<string> {
  private readonly lines: Array<string> = [];
  private waiting: ((result: IteratorResult<string>) => void) | undefined;
  private ended = false;

  push(line: string): void {
    if (this.ended) return;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: line, done: false });
    } else this.lines.push(line);
  }

  end(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const line = this.lines.shift();
        if (line !== undefined) return Promise.resolve({ value: line, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

interface MuseReplayHost {
  readonly ordinal: number;
  readonly incoming: LineQueue;
  readonly ids: Map<number, number>;
  readonly minted: Array<string>;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: null }>;
  readonly exit: () => void;
  open: boolean;
}

/** Adapter fibers can reorder stdin writes; hold matches within the turn until reached, and fail unmatched writes. */
class MuseReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly consumed = new Set<number>();
  private readonly held: Array<{ readonly host: MuseReplayHost; readonly actual: unknown }> = [];
  private readonly hosts: Array<MuseReplayHost> = [];
  private readonly transcript: MuseReplayTranscript;

  constructor(transcript: MuseReplayTranscript) {
    this.transcript = transcript;
  }

  spawn(args: ReadonlyArray<string>): MuseReplayHost {
    let exit = () => {};
    const exited = new Promise<{ readonly code: number | null; readonly signal: null }>(
      (resolve) => {
        exit = () => resolve({ code: 0, signal: null });
      },
    );
    const host: MuseReplayHost = {
      ordinal: this.hosts.length + 1,
      incoming: new LineQueue(),
      ids: new Map(),
      minted: [...(this.transcript.metadata.commandIds[this.hosts.length] ?? [])],
      exited,
      exit,
      open: true,
    };
    this.hosts.push(host);
    this.receive(host, { type: "host_start", args: [...args] });
    return host;
  }

  mint(host: MuseReplayHost): string {
    const id = host.minted.shift();
    if (id === undefined) {
      throw new Error(`Muse replay host ${host.ordinal} minted more ids than were recorded.`);
    }
    return id;
  }

  receive(host: MuseReplayHost, actual: unknown): void {
    if (this.failure !== null) return;
    const entries = this.transcript.entries;
    let possible = false;
    for (let index = this.cursor; index < entries.length && !possible; index += 1) {
      const entry = entries[index]!;
      const pending = entry.type === "expect_outbound" && !this.consumed.has(index);
      possible =
        pending &&
        entryHost(entry) === host.ordinal &&
        replayValueMatches(withRequestId(entry.frame, actual), actual);
      if (!possible && pending && startsTurn(entry)) break;
    }
    if (!possible) {
      this.fail(
        new MuseReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          host: host.ordinal,
          expected: entries[this.cursor] ?? null,
          actual,
        }),
      );
      return;
    }
    this.held.push({ host, actual });
    this.advance();
  }

  close(host: MuseReplayHost): void {
    host.open = false;
    host.incoming.end();
    host.exit();
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length || this.held.length > 0) {
      const nextLabel = entryLabel(this.transcript.entries[this.cursor]);
      throw new MuseReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
        ...(nextLabel === undefined ? {} : { nextLabel }),
      });
    }
  }

  private advance(): void {
    let progressed = true;
    while (progressed && this.failure === null) {
      progressed = this.drainInbound();
      for (const [heldIndex, write] of this.held.entries()) {
        if (this.consumePending(write.host, write.actual)) {
          this.held.splice(heldIndex, 1);
          progressed = true;
          break;
        }
      }
    }
  }

  private consumePending(host: MuseReplayHost, actual: unknown): boolean {
    const entries = this.transcript.entries;
    for (let index = this.cursor; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (entry.type !== "expect_outbound") return false;
      if (this.consumed.has(index) || entryHost(entry) !== host.ordinal) continue;
      if (!replayValueMatches(withRequestId(entry.frame, actual), actual)) continue;
      const recordedId = clientRequestId(entry.frame);
      const actualId = clientRequestId(actual);
      if (recordedId !== undefined && actualId !== undefined) host.ids.set(recordedId, actualId);
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
        this.cursor += 1;
        emitted = true;
        const host = this.hosts.at(-1);
        if (host !== undefined) this.close(host);
        continue;
      }
      if (entry?.type !== "emit_inbound") return emitted;
      const host = this.hosts[entryHost(entry) - 1];
      if (host === undefined) return emitted;
      this.cursor += 1;
      emitted = true;
      // Output a host wrote after T3 released it was never observed.
      if (!host.open) continue;
      const frame = entry.frame;
      // Responses carry the client's request id; server requests carry their own.
      const reboundId =
        isRecord(frame) && frame.method === undefined && typeof frame.id === "number"
          ? host.ids.get(frame.id)
          : undefined;
      const rebound =
        isRecord(frame) && reboundId !== undefined ? { ...frame, id: reboundId } : frame;
      host.incoming.push(`${JSON.stringify(rebound)}\n`);
    }
    return emitted;
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    for (const host of this.hosts) host.incoming.end();
  }
}

export async function connectMuseTransport(input: {
  readonly transport: DuplexTransport;
  readonly readOnly: boolean | undefined;
  readonly mintCommandId?: () => string;
  readonly exited: MuseSdkHost["exited"];
  readonly close: () => Promise<void>;
}): Promise<MuseSdkHost> {
  const connection = new Connection(
    input.transport,
    input.mintCommandId ? { mintCommandId: input.mintCommandId } : {},
  );
  const result = await connection.request("initialize", museInitializeParams(input.readOnly));
  connection.notify("initialized");
  const granted = result.grantedCapabilities;
  return {
    connection,
    initializeResult: {
      grantedCapabilities: Array.isArray(granted)
        ? granted.filter((capability) => typeof capability === "string")
        : [],
    },
    exited: input.exited,
    close: input.close,
  };
}

function makeReplayCreateHost(controller: MuseReplayController) {
  return async (options: MuseSdkHostOptions): Promise<MuseSdkHost> => {
    const host = controller.spawn(museServeArgs(options));
    return connectMuseTransport({
      transport: {
        incoming: host.incoming,
        write: async (line) => {
          for (const part of line.split("\n")) {
            if (part.trim()) controller.receive(host, JSON.parse(part));
          }
        },
        close: () => controller.close(host),
      },
      readOnly: options.readOnly,
      mintCommandId: () => controller.mint(host),
      exited: host.exited,
      close: async () => controller.close(host),
    });
  };
}

const DEFAULT_MUSE_SETTINGS = Schema.decodeUnknownSync(MuseSettings)({ enabled: true });

export function layer(input: {
  readonly scenario: string;
  readonly createHost: NonNullable<Parameters<typeof makeMuseAdapterV2>[0]["createHost"]>;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      return [
        yield* makeMuseAdapterV2({
          instanceId: ProviderInstanceId.make(MUSE_PROVIDER_KIND),
          settings: DEFAULT_MUSE_SETTINGS,
          environment: input.environment ?? {},
          createHost: input.createHost,
          continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        }),
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
}

/** Uses canonical workspace paths, with turn/start in museWorkspaceRoot form (verbatim on Windows). */
export const materializeMuseReplayWorkspace = Effect.fn("materializeMuseReplayWorkspace")(
  function* (transcript: ProviderReplayTranscript, workspace: string) {
    const canonical = yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.realPath(workspace)),
      Effect.provide(NodeServices.layer),
    );
    const plain = materializeReplayTranscriptWorkspace(transcript, canonical);
    const turnStarts = materializeReplayTranscriptWorkspace(
      transcript,
      yield* museWorkspaceRoot(canonical),
    );
    return {
      ...plain,
      entries: plain.entries.map((entry, index) =>
        entry.type === "expect_outbound" &&
        isRecord(entry.frame) &&
        entry.frame.method === "turn/start"
          ? turnStarts.entries[index]!
          : entry,
      ),
    };
  },
);

export const MuseOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  MuseReplayTranscript,
  MuseReplayTranscriptDecodeError
> = {
  driver: ProviderDriverKind.make(MUSE_PROVIDER_KIND),
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeMuseReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) => new MuseReplayTranscriptDecodeError({ scenario: transcript.scenario, cause }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const controller = new MuseReplayController(transcript);
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
        return layer({
          scenario: transcript.scenario,
          createHost: makeReplayCreateHost(controller),
        });
      }),
    ),
};

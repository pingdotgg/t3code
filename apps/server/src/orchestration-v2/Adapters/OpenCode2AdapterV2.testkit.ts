import type { OpencodeClient, V2Event } from "@opencode-ai/sdk-next/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../../provider/Layers/ProviderEventLoggers.ts";
import {
  OpenCode2Runtime,
  OpenCode2RuntimeError,
  type OpenCode2RuntimeOperation,
} from "../../provider/opencode2Runtime.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterDriverCreateError } from "../ProviderAdapterDriver.ts";
import { makeDriverLayer as makeProviderAdapterRegistryDriverLayer } from "../ProviderAdapterRegistry.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import {
  OPENCODE2_DRIVER_KIND,
  OPENCODE2_PROVIDER,
  OPENCODE2_SDK_PROTOCOL,
  OpenCode2AdapterV2Driver,
} from "./OpenCode2AdapterV2.ts";

export const OPENCODE2_SDK_REPLAY_PROTOCOL = OPENCODE2_SDK_PROTOCOL;
export const OPENCODE2_REPLAY_INSTANCE_ID = ProviderInstanceId.make("opencode2");

const OpenCode2SdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OPENCODE2_PROVIDER),
  protocol: Schema.Literal(OPENCODE2_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type OpenCode2SdkReplayTranscript = typeof OpenCode2SdkReplayTranscript.Type;
const decodeOpenCode2SdkReplayTranscript = Schema.decodeUnknownEffect(OpenCode2SdkReplayTranscript);

export class OpenCode2ReplayTranscriptDecodeError extends Schema.TaggedErrorClass<OpenCode2ReplayTranscriptDecodeError>()(
  "OpenCode2ReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode OpenCode 2 replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class OpenCode2ReplayMismatchError extends Schema.TaggedErrorClass<OpenCode2ReplayMismatchError>()(
  "OpenCode2ReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `OpenCode 2 replay frame mismatch at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class OpenCode2ReplayIncompleteError extends Schema.TaggedErrorClass<OpenCode2ReplayIncompleteError>()(
  "OpenCode2ReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `OpenCode 2 replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export const OpenCode2ReplayError = Schema.Union([
  OpenCode2ReplayTranscriptDecodeError,
  OpenCode2ReplayMismatchError,
  OpenCode2ReplayIncompleteError,
]);
export type OpenCode2ReplayError = typeof OpenCode2ReplayError.Type;
export const OpenCode2OrchestratorReplayHarnessError = Schema.Union([
  OpenCode2ReplayError,
  ProviderAdapterDriverCreateError,
]);
export type OpenCode2OrchestratorReplayHarnessError =
  typeof OpenCode2OrchestratorReplayHarnessError.Type;

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === "<any>" || expected === "<workspace>") return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (P.isObject(expected)) {
    if (!P.isObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => replayValueMatches(value, actual[key]));
  }
  return Object.is(expected, actual);
}

function frameRecord(frame: unknown): Record<string, unknown> | null {
  return P.isObject(frame) ? frame : null;
}

function isSignalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

async function waitForReplayDelay(afterMs: number, signal?: AbortSignal): Promise<boolean> {
  if (isSignalAborted(signal)) return false;
  if (signal === undefined) {
    await Effect.runPromise(Effect.sleep(Duration.millis(afterMs)));
    return true;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (completed: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(completed);
    };
    const abort = () => done(false);
    signal.addEventListener("abort", abort, { once: true });
    void Effect.runPromise(Effect.sleep(Duration.millis(afterMs))).then(() => done(true));
    if (signal.aborted) abort();
  });
}

export class OpenCode2ReplayController {
  private cursor = 0;
  private claimedEventCursor: number | null = null;
  private claimedResponseCursor: number | null = null;
  private successfulRuntimeExit = false;
  private readonly waiters = new Set<() => void>();
  private failure: unknown = null;
  private readonly transcript: OpenCode2SdkReplayTranscript;

  constructor(transcript: OpenCode2SdkReplayTranscript) {
    this.transcript = transcript;
  }

  async expectOutbound(actual: unknown): Promise<void> {
    try {
      this.throwFailure();
      while (
        this.claimedEventCursor === this.cursor ||
        this.claimedResponseCursor === this.cursor
      ) {
        await this.changed();
        this.throwFailure();
      }
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type !== "expect_outbound" || !replayValueMatches(entry.frame, actual)) {
        throw new OpenCode2ReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          expected: entry?.type === "expect_outbound" ? entry.frame : (entry ?? null),
          actual,
        });
      }
      this.advance();
    } catch (cause) {
      this.fail(cause);
      throw cause;
    }
  }

  async response(operation: OpenCode2RuntimeOperation): Promise<unknown> {
    while (true) {
      this.throwFailure();
      if (this.claimedResponseCursor === this.cursor) {
        await this.changed();
        continue;
      }
      const entry = this.transcript.entries[this.cursor];
      if (entry === undefined) {
        const mismatch = new OpenCode2ReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          expected: { type: "sdk.response", operation },
          actual: null,
        });
        this.fail(mismatch);
        throw mismatch;
      }
      if (entry?.type === "emit_inbound") {
        const frame = frameRecord(entry.frame);
        if (frame?.type === "sdk.response" && frame.operation === operation) {
          const data = frame.data;
          const claimedCursor = this.cursor;
          this.claimedResponseCursor = claimedCursor;
          try {
            if (entry.afterMs !== undefined && entry.afterMs > 0) {
              await Effect.runPromise(Effect.sleep(Duration.millis(entry.afterMs)));
            }
            this.throwFailure();
            this.advance();
            return data;
          } finally {
            this.releaseResponseClaim(claimedCursor);
          }
        }
        if (frame?.type === "sdk.error" && frame.operation === operation) {
          const claimedCursor = this.cursor;
          this.claimedResponseCursor = claimedCursor;
          try {
            if (entry.afterMs !== undefined && entry.afterMs > 0) {
              await Effect.runPromise(Effect.sleep(Duration.millis(entry.afterMs)));
            }
            this.throwFailure();
            this.advance();
            throw new OpenCode2RuntimeError({
              operation,
              category: "sdk-request-failed",
              cause: frame.error ?? frame.message,
            });
          } finally {
            this.releaseResponseClaim(claimedCursor);
          }
        }
      }
      if (entry?.type === "runtime_exit") {
        const mismatch = new OpenCode2ReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          expected: { type: "sdk.response", operation },
          actual: entry,
        });
        this.fail(mismatch);
        throw mismatch;
      }
      await this.changed();
    }
  }

  async *events(signal?: AbortSignal): AsyncIterable<V2Event> {
    while (true) {
      if (isSignalAborted(signal)) return;
      this.throwFailure();
      if (this.successfulRuntimeExit) return;
      if (this.claimedEventCursor === this.cursor || this.claimedResponseCursor === this.cursor) {
        await this.changed(signal);
        continue;
      }
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "emit_inbound") {
        const frame = frameRecord(entry.frame);
        if (frame?.type === "sdk.event") {
          const claimedCursor = this.cursor;
          this.claimedEventCursor = claimedCursor;
          try {
            if (entry.afterMs !== undefined && entry.afterMs > 0) {
              const delayCompleted = await waitForReplayDelay(entry.afterMs, signal);
              if (!delayCompleted || isSignalAborted(signal)) return;
            }
            this.throwFailure();
            const event = frame.event as V2Event;
            this.advance();
            this.releaseEventClaim(claimedCursor);
            yield event;
            continue;
          } finally {
            this.releaseEventClaim(claimedCursor);
          }
        }
      }
      if (entry?.type === "runtime_exit") {
        if (entry.status === "success") {
          this.successfulRuntimeExit = true;
          this.advance();
          return;
        }
        this.advance();
        const mismatch = new OpenCode2ReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor - 1,
          expected: { status: "success" },
          actual: entry,
        });
        this.fail(mismatch);
        throw mismatch;
      }
      await this.changed(signal);
    }
  }

  assertComplete(): void {
    while (this.transcript.entries[this.cursor]?.type === "runtime_exit") {
      const exit = this.transcript.entries[this.cursor];
      if (exit?.type !== "runtime_exit" || exit.status !== "success") break;
      this.successfulRuntimeExit = true;
      this.advance();
    }
    this.throwFailure();
    if (this.cursor !== this.transcript.entries.length) {
      throw new OpenCode2ReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
      });
    }
  }

  private advance(): void {
    this.cursor += 1;
    this.notifyWaiters();
  }

  private releaseEventClaim(cursor: number): void {
    if (this.claimedEventCursor !== cursor) return;
    this.claimedEventCursor = null;
    this.notifyWaiters();
  }

  private releaseResponseClaim(cursor: number): void {
    if (this.claimedResponseCursor !== cursor) return;
    this.claimedResponseCursor = null;
    this.notifyWaiters();
  }

  private notifyWaiters(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private fail(cause: unknown): void {
    this.failure = cause;
    this.notifyWaiters();
  }

  private throwFailure(): void {
    if (this.failure !== null) throw this.failure;
  }

  private changed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export function makeReplayClient(controller: OpenCode2ReplayController): OpencodeClient {
  const request = async (operation: OpenCode2RuntimeOperation, input: unknown) => {
    await controller.expectOutbound({ type: operation, input });
    return { data: { data: await controller.response(operation) } };
  };
  return {
    v2: {
      agent: {
        list: (input: unknown) => request("agent.list", input),
      },
      event: {
        subscribe: async (options?: { readonly signal?: AbortSignal }) => {
          await controller.expectOutbound({ type: "event.subscribe" });
          return { stream: controller.events(options?.signal) };
        },
      },
      message: {
        list: (input: unknown) => request("message.list", input),
      },
      mcp: {
        list: (input: unknown) => request("mcp.list", input),
      },
      model: {
        list: (input: unknown) => request("model.list", input),
      },
      session: {
        create: (input: unknown) => request("session.create", input),
        fork: (input: unknown) => request("session.fork", input),
        get: (input: unknown) => request("session.get", input),
        interrupt: (input: unknown) => request("session.interrupt", input),
        instructions: {
          entry: {
            put: (input: unknown) => request("session.instructions.entry.put", input),
          },
        },
        pending: {
          list: (input: unknown) => request("session.pending.list", input),
        },
        permission: {
          reply: (input: unknown) => request("session.permission.reply", input),
        },
        prompt: (input: unknown) => request("session.prompt", input),
        remove: (input: unknown) => request("session.remove", input),
        question: {
          reply: (input: unknown) => request("session.question.reply", input),
        },
        revert: {
          commit: (input: unknown) => request("session.revert.commit", input),
          stage: (input: unknown) => request("session.revert.stage", input),
        },
        form: {
          reply: (input: unknown) => request("session.form.reply", input),
        },
        switchAgent: (input: unknown) => request("session.switchAgent", input),
        switchModel: (input: unknown) => request("session.switchModel", input),
      },
      shell: {
        list: (input: unknown) => request("shell.list", input),
        output: (input: unknown) => request("shell.output", input),
        remove: (input: unknown) => request("shell.remove", input),
      },
    },
  } as unknown as OpencodeClient;
}

function makeOpenCode2ReplayRuntimeLayer(transcript: OpenCode2SdkReplayTranscript) {
  return Layer.effect(
    OpenCode2Runtime,
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(transcript);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          controller.assertComplete();
        }),
      );
      const client = makeReplayClient(controller);
      return OpenCode2Runtime.of({
        startOpenCode2ServerProcess: () =>
          Effect.fail(
            new OpenCode2RuntimeError({
              operation: "startOpenCode2ServerProcess",
              category: "replay-boundary",
            }),
          ),
        connectToOpenCode2Server: () =>
          Effect.succeed({
            url: "replay://opencode2",
            password: "replay-password",
            exitCode: null,
            external: true,
          }),
        createOpenCode2SdkClient: () => client,
      } satisfies OpenCode2Runtime["Service"]);
    }),
  );
}

export function makeOpenCode2ProviderAdapterRegistryReplayLayer(
  transcript: OpenCode2SdkReplayTranscript,
) {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return makeProviderAdapterRegistryDriverLayer({
    drivers: [OpenCode2AdapterV2Driver],
    configMap: {
      [OPENCODE2_REPLAY_INSTANCE_ID]: {
        driver: OPENCODE2_DRIVER_KIND,
        config: {
          serverUrl: "replay://opencode2",
          serverPassword: "replay-password",
        },
      },
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        makeOpenCode2ReplayRuntimeLayer(transcript),
        serverConfigLayer,
        NodeServices.layer,
        idAllocatorLayer,
        Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
      ),
    ),
  );
}

function transcriptMetadata(transcript: ProviderReplayTranscript) {
  return {
    driver: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export const OpenCode2OrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  OpenCode2SdkReplayTranscript,
  OpenCode2OrchestratorReplayHarnessError
> = {
  driver: OPENCODE2_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeOpenCode2SdkReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new OpenCode2ReplayTranscriptDecodeError({
            ...transcriptMetadata(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: makeOpenCode2ProviderAdapterRegistryReplayLayer,
};

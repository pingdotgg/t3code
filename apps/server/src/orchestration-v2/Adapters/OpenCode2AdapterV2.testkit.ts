import type { OpenCodeClient, V2Event } from "@opencode-ai/client";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(actual, key) && replayValueMatches(value, actual[key]),
    );
  }
  if (
    (typeof expected === "string" && typeof actual === "number" && expected === String(actual)) ||
    (typeof expected === "number" && typeof actual === "string" && String(expected) === actual)
  ) {
    return true;
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
  const exit = await Effect.runPromiseExit(Effect.sleep(Duration.millis(afterMs)), { signal });
  if (Exit.isSuccess(exit)) return true;
  if (Cause.hasInterruptsOnly(exit.cause)) return false;
  throw Cause.squash(exit.cause);
}

export class OpenCode2ReplayController {
  private cursor = 0;
  private claimedEventCursor: number | null = null;
  private claimedResponseCursor: number | null = null;
  private currentEventEpoch = 0;
  private pendingEventHandling = false;
  private successfulRuntimeExit = false;
  private readonly waiters = new Set<() => void>();
  private failure: unknown = null;
  private readonly transcript: OpenCode2SdkReplayTranscript;
  private readonly abortController = new AbortController();

  constructor(transcript: OpenCode2SdkReplayTranscript) {
    this.transcript = transcript;
  }

  /** Non-consuming look at the next transcript entry. */
  peek(): OpenCode2SdkReplayTranscript["entries"][number] | undefined {
    return this.transcript.entries[this.cursor];
  }

  /**
   * True when the next entry is an outbound expect for this operation. Used so
   * optional startup catalog probes can fall back to canned data when a
   * fixture does not record them, without racing the event stream.
   */
  expectsOutbound(operation: string): boolean {
    const entry = this.peek();
    if (entry?.type !== "expect_outbound") return false;
    const frame = entry.frame;
    return (
      typeof frame === "object" &&
      frame !== null &&
      "type" in frame &&
      (frame as { readonly type?: string }).type === operation
    );
  }

  /** Wait until a delayed replay consumer releases the cursor, then inspect it. */
  async expectsOptionalOutbound(operation: string): Promise<boolean> {
    this.throwFailure();
    while (this.claimedEventCursor === this.cursor || this.claimedResponseCursor === this.cursor) {
      await this.changed();
      this.throwFailure();
    }
    return this.expectsOutbound(operation);
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

  eventEpoch(): number {
    return this.currentEventEpoch;
  }

  async response(
    operation: OpenCode2RuntimeOperation,
    startedAtEventEpoch = this.currentEventEpoch,
  ): Promise<unknown> {
    while (true) {
      this.throwFailure();
      if (this.abortController.signal.aborted) {
        throw new Error(`OpenCode 2 replay aborted while waiting for ${operation}.`);
      }
      if (
        this.claimedResponseCursor === this.cursor ||
        (this.pendingEventHandling && startedAtEventEpoch < this.currentEventEpoch)
      ) {
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
              const delayCompleted = await waitForReplayDelay(
                entry.afterMs,
                this.abortController.signal,
              );
              if (!delayCompleted) {
                throw new Error(`OpenCode 2 replay aborted while waiting for ${operation}.`);
              }
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
              const delayCompleted = await waitForReplayDelay(
                entry.afterMs,
                this.abortController.signal,
              );
              if (!delayCompleted) {
                throw new Error(`OpenCode 2 replay aborted while waiting for ${operation}.`);
              }
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
      this.throwFailure();
      if (isSignalAborted(signal) || this.abortController.signal.aborted) return;
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
              const delayCompleted = await waitForReplayDelay(
                entry.afterMs,
                this.replaySignal(signal),
              );
              if (!delayCompleted || isSignalAborted(signal)) return;
            }
            this.throwFailure();
            const event = frame.event as V2Event;
            this.advance();
            this.currentEventEpoch += 1;
            this.pendingEventHandling = true;
            try {
              yield event;
            } finally {
              this.pendingEventHandling = false;
              this.notifyWaiters();
            }
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

  /** Abort every pending replay consumer when its owning runtime scope closes. */
  abort(): void {
    this.abortController.abort();
    this.notifyWaiters();
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
    if (this.failure === null) this.failure = cause;
    this.abortController.abort();
    this.notifyWaiters();
  }

  private replaySignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.abortController.signal
      : AbortSignal.any([signal, this.abortController.signal]);
  }

  private throwFailure(): void {
    if (this.failure !== null) throw this.failure;
  }

  private changed(signal?: AbortSignal): Promise<void> {
    const replaySignal = this.replaySignal(signal);
    if (replaySignal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        replaySignal.removeEventListener("abort", done);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      replaySignal.addEventListener("abort", done, { once: true });
    });
  }
}

export function makeReplayClient(controller: OpenCode2ReplayController): OpenCodeClient {
  const request = async (operation: OpenCode2RuntimeOperation, input: unknown) => {
    const startedAtEventEpoch = controller.eventEpoch();
    await controller.expectOutbound({ type: operation, input });
    return { data: { data: await controller.response(operation, startedAtEventEpoch) } };
  };
  /**
   * Catalog probes may run at openSession/ensureThread before the transcript
   * records them. Prefer the transcript when present; otherwise return canned
   * data so event.subscribe stays first and fixtures do not deadlock.
   */
  const optionalCatalog = async (
    operation: OpenCode2RuntimeOperation,
    input: unknown,
    canned: unknown,
  ) => {
    if (!(await controller.expectsOptionalOutbound(operation))) {
      return { data: { data: canned } };
    }
    return request(operation, input);
  };
  return {
    agent: {
      list: (input: unknown) =>
        optionalCatalog("agent.list", input, [{ id: "build" }, { id: "plan" }]),
    },
    event: {
      subscribe: (options?: { readonly signal?: AbortSignal }) => {
        const subscribed = controller.expectOutbound({ type: "event.subscribe" });
        return {
          async *[Symbol.asyncIterator]() {
            await subscribed;
            yield* controller.events(options?.signal);
          },
        };
      },
    },
    form: {
      reply: (input: {
        readonly sessionID: string;
        readonly formID: string;
        readonly answer: unknown;
      }) => {
        if (controller.expectsOutbound("session.question.reply")) {
          const answers = P.isObject(input.answer) ? Object.values(input.answer) : [input.answer];
          return request("session.question.reply", {
            sessionID: input.sessionID,
            requestID: input.formID,
            questionV2Reply: { answers },
          });
        }
        return request("session.form.reply", input);
      },
    },
    message: {
      list: (input: unknown) => request("message.list", input),
    },
    mcp: {
      list: (input: unknown) => optionalCatalog("mcp.list", input, []),
    },
    model: {
      list: (input: unknown) => optionalCatalog("model.list", input, []),
    },
    permission: {
      reply: (input: unknown) => request("session.permission.reply", input),
    },
    session: {
      context: (input: unknown) => request("session.context", input),
      create: (input: unknown) => request("session.create", input),
      fork: (input: { readonly sessionID: string; readonly boundary: unknown }) =>
        request("session.fork", {
          sessionID: input.sessionID,
          $body_boundary: input.boundary,
        }),
      get: (input: unknown) => request("session.get", input),
      inbox: {
        list: (input: unknown) => request("session.pending.list", input),
      },
      instructions: {
        entry: {
          put: (input: unknown) => request("session.instructions.entry.put", input),
        },
      },
      interrupt: (input: unknown) => request("session.interrupt", input),
      prompt: (input: {
        readonly sessionID: string;
        readonly text: string;
        readonly files?: unknown;
        readonly delivery?: string;
      }) => {
        if (typeof input.text !== "string") {
          throw new Error("Replay session.prompt must use a flat text body.");
        }
        const prompt = {
          text: input.text,
          ...(input.files === undefined ? {} : { files: input.files }),
        };
        return request("session.prompt", {
          sessionID: input.sessionID,
          prompt,
          ...(typeof input.delivery === "string" ? { delivery: input.delivery } : {}),
        });
      },
      remove: (input: unknown) => request("session.remove", input),
      revert: {
        commit: (input: unknown) => request("session.revert.commit", input),
        stage: (input: unknown) => request("session.revert.stage", input),
      },
      switchAgent: (input: unknown) => request("session.switchAgent", input),
      switchModel: (input: unknown) => request("session.switchModel", input),
      wait: (input: unknown) => request("session.wait", input),
    },
    shell: {
      list: (input: unknown) => request("shell.list", input),
      output: (input: unknown) => request("shell.output", input),
      remove: (input: unknown) => request("shell.remove", input),
    },
  } as unknown as OpenCodeClient;
}

function makeOpenCode2ReplayRuntimeLayer(transcript: OpenCode2SdkReplayTranscript) {
  return Layer.effect(
    OpenCode2Runtime,
    Effect.gen(function* () {
      const controller = new OpenCode2ReplayController(transcript);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          controller.abort();
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

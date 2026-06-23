import type { Event as OpenCodeEvent, OpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderReplayEntry, type ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../../provider/opencodeRuntime.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../../provider/Layers/ProviderEventLoggers.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterDriverCreateError } from "../ProviderAdapterDriver.ts";
import { makeDriverLayer as makeProviderAdapterRegistryDriverLayer } from "../ProviderAdapterRegistry.ts";
import {
  makeReplayServerConfig,
  type OrchestratorV2ProviderReplayHarness,
} from "../testkit/ProviderReplayHarness.ts";
import {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_DRIVER_KIND,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
  OpenCodeAdapterV2Driver,
} from "./OpenCodeAdapterV2.ts";

export const OPENCODE_SDK_REPLAY_PROTOCOL = OPENCODE_SDK_PROTOCOL;

const OpenCodeSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OPENCODE_PROVIDER),
  protocol: Schema.Literal(OPENCODE_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type OpenCodeSdkReplayTranscript = typeof OpenCodeSdkReplayTranscript.Type;
const decodeOpenCodeSdkReplayTranscript = Schema.decodeUnknownEffect(OpenCodeSdkReplayTranscript);

export class OpenCodeReplayTranscriptDecodeError extends Schema.TaggedErrorClass<OpenCodeReplayTranscriptDecodeError>()(
  "OpenCodeReplayTranscriptDecodeError",
  {
    driver: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode OpenCode replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class OpenCodeReplayMismatchError extends Schema.TaggedErrorClass<OpenCodeReplayMismatchError>()(
  "OpenCodeReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `OpenCode replay frame mismatch at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class OpenCodeReplayIncompleteError extends Schema.TaggedErrorClass<OpenCodeReplayIncompleteError>()(
  "OpenCodeReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `OpenCode replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export const OpenCodeReplayError = Schema.Union([
  OpenCodeReplayTranscriptDecodeError,
  OpenCodeReplayMismatchError,
  OpenCodeReplayIncompleteError,
]);
export type OpenCodeReplayError = typeof OpenCodeReplayError.Type;
export const OpenCodeOrchestratorReplayHarnessError = Schema.Union([
  OpenCodeReplayError,
  ProviderAdapterDriverCreateError,
]);
export type OpenCodeOrchestratorReplayHarnessError =
  typeof OpenCodeOrchestratorReplayHarnessError.Type;

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === "<any>" || expected === "<workspace>") return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) return false;
    return Object.entries(expected).every(([key, value]) =>
      replayValueMatches(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return Object.is(expected, actual);
}

function frameRecord(frame: unknown): Record<string, unknown> | null {
  return typeof frame === "object" && frame !== null ? (frame as Record<string, unknown>) : null;
}

class OpenCodeReplayController {
  private cursor = 0;
  private readonly waiters = new Set<() => void>();
  private failure: unknown = null;
  private readonly transcript: OpenCodeSdkReplayTranscript;

  constructor(transcript: OpenCodeSdkReplayTranscript) {
    this.transcript = transcript;
  }

  async expectOutbound(actual: unknown): Promise<void> {
    try {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type !== "expect_outbound" || !replayValueMatches(entry.frame, actual)) {
        throw new OpenCodeReplayMismatchError({
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

  async response(operation: string): Promise<unknown> {
    while (true) {
      this.throwFailure();
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "emit_inbound") {
        const frame = frameRecord(entry.frame);
        if (frame?.type === "sdk.response" && frame.operation === operation) {
          if (entry.afterMs !== undefined && entry.afterMs > 0) {
            await Effect.runPromise(Effect.sleep(Duration.millis(entry.afterMs)));
          }
          const data = frame.data;
          this.advance();
          return data;
        }
      }
      if (entry?.type === "runtime_exit") {
        const mismatch = new OpenCodeReplayMismatchError({
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

  async *events(signal?: AbortSignal): AsyncIterable<OpenCodeEvent> {
    while (true) {
      if (signal?.aborted === true) return;
      this.throwFailure();
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "emit_inbound") {
        const frame = frameRecord(entry.frame);
        if (frame?.type === "sdk.event") {
          if (entry.afterMs !== undefined && entry.afterMs > 0) {
            await Effect.runPromise(Effect.sleep(Duration.millis(entry.afterMs)));
          }
          const event = frame.event as OpenCodeEvent;
          this.advance();
          yield event;
          continue;
        }
      }
      if (entry?.type === "runtime_exit") {
        this.advance();
        if (entry.status === "success") return;
        const mismatch = new OpenCodeReplayMismatchError({
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
      this.cursor += 1;
    }
    this.throwFailure();
    if (this.cursor !== this.transcript.entries.length) {
      throw new OpenCodeReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
      });
    }
  }

  private advance(): void {
    this.cursor += 1;
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  private fail(cause: unknown): void {
    this.failure = cause;
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
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

function makeReplayClient(controller: OpenCodeReplayController): OpencodeClient {
  const request = async (operation: string, input: unknown) => {
    await controller.expectOutbound({ type: operation, input });
    return { data: await controller.response(operation) };
  };
  return {
    event: {
      subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => {
        await controller.expectOutbound({ type: "event.subscribe" });
        return { stream: controller.events(options?.signal) };
      },
    },
    session: {
      create: (input: unknown) => request("session.create", input),
      get: (input: unknown) => request("session.get", input),
      update: (input: unknown) => request("session.update", input),
      messages: (input: unknown) => request("session.messages", input),
      promptAsync: (input: unknown) => request("session.promptAsync", input),
      abort: (input: unknown) => request("session.abort", input),
      revert: (input: unknown) => request("session.revert", input),
      unrevert: (input: unknown) => request("session.unrevert", input),
      fork: (input: unknown) => request("session.fork", input),
    },
    permission: {
      reply: (input: unknown) => request("permission.reply", input),
    },
    question: {
      reply: (input: unknown) => request("question.reply", input),
    },
    mcp: {
      add: (input: unknown) => request("mcp.add", input),
    },
  } as unknown as OpencodeClient;
}

function makeOpenCodeReplayRuntimeLayer(transcript: OpenCodeSdkReplayTranscript) {
  return Layer.effect(
    OpenCodeRuntime,
    Effect.gen(function* () {
      const controller = new OpenCodeReplayController(transcript);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          controller.assertComplete();
        }),
      );
      const client = makeReplayClient(controller);
      return OpenCodeRuntime.of({
        startOpenCodeServerProcess: () =>
          Effect.fail(
            new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: "OpenCode replay uses an external in-memory SDK boundary.",
            }),
          ),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "replay://opencode",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: () =>
          Effect.fail(
            new OpenCodeRuntimeError({
              operation: "runOpenCodeCommand",
              detail: "OpenCode replay does not execute commands.",
            }),
          ),
        createOpenCodeSdkClient: () => client,
        loadOpenCodeInventory: () =>
          Effect.fail(
            new OpenCodeRuntimeError({
              operation: "loadOpenCodeInventory",
              detail: "OpenCode replay does not load inventory.",
            }),
          ),
      } satisfies OpenCodeRuntimeShape);
    }),
  );
}

export function makeOpenCodeProviderAdapterRegistryReplayLayer(
  transcript: OpenCodeSdkReplayTranscript,
) {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  return makeProviderAdapterRegistryDriverLayer({
    drivers: [OpenCodeAdapterV2Driver],
    configMap: {
      [OPENCODE_DEFAULT_INSTANCE_ID]: {
        driver: OPENCODE_DRIVER_KIND,
        config: { serverUrl: "replay://opencode" },
      },
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        makeOpenCodeReplayRuntimeLayer(transcript),
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
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export const OpenCodeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  OpenCodeSdkReplayTranscript,
  OpenCodeOrchestratorReplayHarnessError
> = {
  driver: OPENCODE_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeOpenCodeSdkReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeReplayTranscriptDecodeError({
            ...transcriptMetadata(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: makeOpenCodeProviderAdapterRegistryReplayLayer,
};

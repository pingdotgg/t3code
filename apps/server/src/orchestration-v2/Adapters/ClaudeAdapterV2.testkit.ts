import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import { Effect, Layer, Random, Schema, Stream } from "effect";

import {
  CLAUDE_PROVIDER,
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerError,
  layer as claudeAdapterLayer,
  makeClaudeQueryOptions,
  type ClaudeAgentSdkQueryInput,
  type ClaudeAgentSdkQueryOptions,
} from "./ClaudeAdapterV2.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { layerFromProviderAdapter } from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

export const CLAUDE_AGENT_SDK_REPLAY_PROTOCOL = "claude-agent-sdk.query" as const;

const ClaudeAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CLAUDE_PROVIDER),
  protocol: Schema.Literal(CLAUDE_AGENT_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type ClaudeAgentSdkReplayTranscript = typeof ClaudeAgentSdkReplayTranscript.Type;

export class ClaudeReplayTranscriptDecodeError extends Schema.TaggedErrorClass<ClaudeReplayTranscriptDecodeError>()(
  "ClaudeReplayTranscriptDecodeError",
  {
    provider: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to decode Claude Agent SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class ClaudeReplayExhaustedError extends Schema.TaggedErrorClass<ClaudeReplayExhaustedError>()(
  "ClaudeReplayExhaustedError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay transcript exhausted before outbound frame ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayUnexpectedOutboundError extends Schema.TaggedErrorClass<ClaudeReplayUnexpectedOutboundError>()(
  "ClaudeReplayUnexpectedOutboundError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expectedType: Schema.String,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Unexpected outbound Claude Agent SDK frame at replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayFrameMismatchError extends Schema.TaggedErrorClass<ClaudeReplayFrameMismatchError>()(
  "ClaudeReplayFrameMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Outbound Claude Agent SDK frame did not match replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayRuntimeExitError extends Schema.TaggedErrorClass<ClaudeReplayRuntimeExitError>()(
  "ClaudeReplayRuntimeExitError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    status: Schema.Literals(["error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay exited with status ${this.status} at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayIncompleteError extends Schema.TaggedErrorClass<ClaudeReplayIncompleteError>()(
  "ClaudeReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayDriverError extends Schema.TaggedErrorClass<ClaudeReplayDriverError>()(
  "ClaudeReplayDriverError",
  {
    scenario: Schema.String,
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay driver failed in scenario ${this.scenario}.`;
  }
}

export const ClaudeAgentSdkReplayError = Schema.Union([
  ClaudeReplayTranscriptDecodeError,
  ClaudeReplayExhaustedError,
  ClaudeReplayUnexpectedOutboundError,
  ClaudeReplayFrameMismatchError,
  ClaudeReplayRuntimeExitError,
  ClaudeReplayIncompleteError,
  ClaudeReplayDriverError,
]);
export type ClaudeAgentSdkReplayError = typeof ClaudeAgentSdkReplayError.Type;

interface ClaudeQueryFrame {
  readonly type: "query";
  readonly prompt: string;
  readonly options: ClaudeAgentSdkQueryOptions;
}

interface ClaudeQueryRunner {
  readonly run: (input: ClaudeAgentSdkQueryInput) => AsyncIterable<SDKMessage>;
  readonly assertComplete: () => void;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameFrame(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sdkMessageFromReplayFrame(frame: unknown): SDKMessage {
  return frame as SDKMessage;
}

function stableClaudeQueryOptions(options: ClaudeAgentSdkQueryOptions): ClaudeAgentSdkQueryOptions {
  return {
    model: options.model,
    tools: options.tools,
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    sessionId: options.sessionId,
  };
}

function makeClaudeQueryFrame(input: ClaudeAgentSdkQueryInput): ClaudeQueryFrame {
  return {
    type: "query",
    prompt: input.prompt,
    options: stableClaudeQueryOptions(input.options),
  };
}

function makeReplayQueryRunner(transcript: ClaudeAgentSdkReplayTranscript): ClaudeQueryRunner {
  let cursor = 0;
  let failure: ClaudeAgentSdkReplayError | null = null;

  const fail = (error: ClaudeAgentSdkReplayError): never => {
    failure = error;
    throw error;
  };

  async function* replayMessages(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      if (failure !== null) {
        throw failure;
      }

      const entry = transcript.entries[cursor];
      if (entry === undefined) {
        return;
      }

      if (entry.type === "emit_inbound") {
        cursor += 1;
        yield sdkMessageFromReplayFrame(entry.frame);
        continue;
      }

      if (entry.type === "runtime_exit") {
        cursor += 1;
        if (entry.status === "success") {
          return;
        }
        fail(
          new ClaudeReplayRuntimeExitError({
            scenario: transcript.scenario,
            cursor: cursor - 1,
            status: entry.status,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          }),
        );
      }

      fail(
        new ClaudeReplayUnexpectedOutboundError({
          scenario: transcript.scenario,
          cursor,
          expectedType: entry.type,
          actual: { type: "query_stream" },
        }),
      );
    }
  }

  const assertNextQueryFrame = (input: ClaudeAgentSdkQueryInput) => {
    if (failure !== null) {
      throw failure;
    }
    const actual = makeClaudeQueryFrame(input);
    const entry = transcript.entries[cursor];
    if (entry === undefined) {
      return fail(
        new ClaudeReplayExhaustedError({
          scenario: transcript.scenario,
          cursor,
          actual,
        }),
      );
    }
    if (entry.type !== "expect_outbound") {
      return fail(
        new ClaudeReplayUnexpectedOutboundError({
          scenario: transcript.scenario,
          cursor,
          expectedType: entry.type,
          actual,
        }),
      );
    }

    const expected = entry.frame;
    if (!sameFrame(expected, actual)) {
      fail(
        new ClaudeReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          expected,
          actual,
        }),
      );
    }

    cursor += 1;
  };

  return {
    run: (input) => {
      assertNextQueryFrame(input);
      return replayMessages();
    },
    assertComplete: () => {
      if (failure !== null) {
        throw failure;
      }
      if (cursor !== transcript.entries.length) {
        throw new ClaudeReplayIncompleteError({
          scenario: transcript.scenario,
          cursor,
          remaining: transcript.entries.length - cursor,
        });
      }
    },
  };
}

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

function nativeSessionIdFor(transcript: ClaudeAgentSdkReplayTranscript): string {
  const metadataSessionId = transcript.metadata?.nativeSessionId;
  return typeof metadataSessionId === "string"
    ? metadataSessionId
    : "00000000-0000-4000-8000-000000000000";
}

function replayQueryRunnerError(
  transcript: ClaudeAgentSdkReplayTranscript,
  cause: unknown,
): ClaudeAgentSdkQueryRunnerError {
  if (Schema.is(ClaudeAgentSdkQueryRunnerError)(cause)) {
    return cause;
  }
  const replayCause = Schema.is(ClaudeAgentSdkReplayError)(cause)
    ? cause
    : new ClaudeReplayDriverError({ scenario: transcript.scenario, cause });
  return new ClaudeAgentSdkQueryRunnerError({ cause: replayCause });
}

export function makeClaudeAgentSdkReplayQueryRunnerLayer(
  transcript: ClaudeAgentSdkReplayTranscript,
): Layer.Layer<ClaudeAgentSdkQueryRunner> {
  return Layer.sync(ClaudeAgentSdkQueryRunner, () => {
    const queryRunner = makeReplayQueryRunner(transcript);

    return ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: Effect.succeed(nativeSessionIdFor(transcript)),
      run: (input) =>
        Stream.unwrap(
          Effect.try({
            try: () => queryRunner.run(input),
            catch: (cause) => replayQueryRunnerError(transcript, cause),
          }).pipe(
            Effect.map((messages) =>
              Stream.fromAsyncIterable(messages, (cause) =>
                replayQueryRunnerError(transcript, cause),
              ),
            ),
          ),
        ),
      assertComplete: Effect.try({
        try: () => queryRunner.assertComplete(),
        catch: (cause) => replayQueryRunnerError(transcript, cause),
      }),
    });
  });
}

export function makeClaudeProviderAdapterRegistryReplayLayer(
  transcript: ClaudeAgentSdkReplayTranscript,
) {
  const adapterLayer = claudeAdapterLayer.pipe(
    Layer.provide(makeClaudeAgentSdkReplayQueryRunnerLayer(transcript)),
    Layer.provide(idAllocatorLayer),
  );
  return layerFromProviderAdapter.pipe(Layer.provide(adapterLayer));
}

export async function replayClaudeAgentSdkTranscript(input: {
  readonly transcript: ClaudeAgentSdkReplayTranscript;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly cwd?: string;
}): Promise<ReadonlyArray<SDKMessage>> {
  const queryRunner = makeReplayQueryRunner(input.transcript);
  const messages: Array<SDKMessage> = [];
  const stream = queryRunner.run({
    prompt: input.prompt,
    options: makeClaudeQueryOptions({
      modelSelection: input.modelSelection,
      sessionId: nativeSessionIdFor(input.transcript),
      cwd: input.cwd ?? null,
    }),
  });
  for await (const message of stream) {
    messages.push(message);
  }
  queryRunner.assertComplete();
  return messages;
}

function serializeReplayError(error: unknown): unknown {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
      }
    : error;
}

export async function recordClaudeAgentSdkReplayTranscript(input: {
  readonly scenario: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId?: string;
}): Promise<ClaudeAgentSdkReplayTranscript> {
  const entries: Array<ProviderReplayEntry> = [];
  const sessionId = input.sessionId ?? (await Effect.runPromise(Random.nextUUIDv4));
  const queryInput = {
    prompt: input.prompt,
    options: makeClaudeQueryOptions({
      modelSelection: input.modelSelection,
      sessionId,
      cwd: input.cwd,
    }),
  };

  entries.push({
    type: "expect_outbound",
    label: "query",
    frame: makeClaudeQueryFrame(queryInput),
  });

  try {
    const stream = query(queryInput);
    for await (const message of stream) {
      entries.push({
        type: "emit_inbound",
        label: message.type,
        frame: message,
      });
    }
    entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error),
    });
    throw error;
  }

  return {
    provider: CLAUDE_PROVIDER,
    protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
    version: "0.2.111",
    scenario: input.scenario,
    metadata: {
      prompt: input.prompt,
      model: input.modelSelection.model,
      nativeSessionId: sessionId,
      generatedBy: "recordClaudeAgentSdkReplayTranscript",
    },
    entries,
  };
}

export const ClaudeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  ClaudeAgentSdkReplayTranscript,
  ClaudeAgentSdkReplayError
> = {
  provider: CLAUDE_PROVIDER,
  decodeTranscript: (transcript) =>
    Schema.decodeUnknownEffect(ClaudeAgentSdkReplayTranscript)(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    makeClaudeProviderAdapterRegistryReplayLayer(transcript),
};

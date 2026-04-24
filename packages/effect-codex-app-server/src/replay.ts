import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { CodexAppServerClient } from "./client.ts";
import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";

export const CodexAppServerReplayEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("expect_outbound"),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("emit_inbound"),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
    afterMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_exit"),
    status: Schema.Literals(["success", "error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  }),
]);
export type CodexAppServerReplayEntry = typeof CodexAppServerReplayEntry.Type;

export const CodexAppServerReplayTranscript = Schema.Struct({
  provider: Schema.Literal("codex"),
  protocol: Schema.Literal("codex.app-server"),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(CodexAppServerReplayEntry),
});
export type CodexAppServerReplayTranscript = typeof CodexAppServerReplayTranscript.Type;

export class CodexAppServerReplayJsonParseError extends Schema.TaggedErrorClass<CodexAppServerReplayJsonParseError>()(
  "CodexAppServerReplayJsonParseError",
  {
    scenario: Schema.String,
    line: Schema.String,
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to parse outbound Codex app-server replay frame for scenario ${this.scenario}.`;
  }
}

export class CodexAppServerReplayExhaustedError extends Schema.TaggedErrorClass<CodexAppServerReplayExhaustedError>()(
  "CodexAppServerReplayExhaustedError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Codex app-server replay transcript exhausted before outbound frame ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class CodexAppServerReplayUnexpectedOutboundError extends Schema.TaggedErrorClass<CodexAppServerReplayUnexpectedOutboundError>()(
  "CodexAppServerReplayUnexpectedOutboundError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expectedType: Schema.String,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Unexpected outbound Codex app-server frame at replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class CodexAppServerReplayFrameMismatchError extends Schema.TaggedErrorClass<CodexAppServerReplayFrameMismatchError>()(
  "CodexAppServerReplayFrameMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Outbound Codex app-server frame did not match replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class CodexAppServerReplayRuntimeExitError extends Schema.TaggedErrorClass<CodexAppServerReplayRuntimeExitError>()(
  "CodexAppServerReplayRuntimeExitError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    status: Schema.Literals(["error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Codex app-server replay exited with status ${this.status} at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class CodexAppServerReplayIncompleteError extends Schema.TaggedErrorClass<CodexAppServerReplayIncompleteError>()(
  "CodexAppServerReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `Codex app-server replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export const CodexAppServerReplayError = Schema.Union([
  CodexAppServerReplayJsonParseError,
  CodexAppServerReplayExhaustedError,
  CodexAppServerReplayUnexpectedOutboundError,
  CodexAppServerReplayFrameMismatchError,
  CodexAppServerReplayRuntimeExitError,
  CodexAppServerReplayIncompleteError,
]);
export type CodexAppServerReplayError = typeof CodexAppServerReplayError.Type;

export interface CodexAppServerReplayState {
  readonly cursor: number;
  readonly failure: CodexAppServerReplayError | null;
}

export interface CodexAppServerReplayDriver {
  readonly transcript: CodexAppServerReplayTranscript;
  readonly state: Ref.Ref<CodexAppServerReplayState>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function normalizeReplayFrame(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeReplayFrame);
  }

  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, normalizeReplayFrame(entry)]),
  );

  if (
    normalized.method === "initialize" &&
    typeof normalized.params === "object" &&
    normalized.params !== null
  ) {
    const params = normalized.params as Record<string, unknown>;
    if (typeof params.clientInfo === "object" && params.clientInfo !== null) {
      normalized.params = {
        ...params,
        clientInfo: {
          ...(params.clientInfo as Record<string, unknown>),
          version: "<ignored>",
        },
      };
    }
  }

  return normalized;
}

function sameFrame(left: unknown, right: unknown): boolean {
  return (
    stableStringify(normalizeReplayFrame(left)) === stableStringify(normalizeReplayFrame(right))
  );
}

function encodeInboundFrame(frame: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(frame)}\n`);
}

function replayTransportError(
  transcript: CodexAppServerReplayTranscript,
  error: CodexAppServerReplayError,
): CodexError.CodexAppServerTransportError {
  return new CodexError.CodexAppServerTransportError({
    detail: error.message,
    cause: error,
  });
}

export function layerReplay(
  transcript: CodexAppServerReplayTranscript,
): Layer.Layer<CodexAppServerClient, CodexAppServerReplayError> {
  return Layer.effect(CodexAppServerClient, makeReplayClient(transcript));
}

export const makeReplayDriver = Effect.fn("effect-codex-app-server/replay.makeReplayDriver")(
  function* (transcript: CodexAppServerReplayTranscript) {
    return {
      transcript,
      state: yield* Ref.make<CodexAppServerReplayState>({ cursor: 0, failure: null }),
    } satisfies CodexAppServerReplayDriver;
  },
);

export function layerReplayWithDriver(
  driver: CodexAppServerReplayDriver,
): Layer.Layer<CodexAppServerClient, CodexAppServerReplayError> {
  return Layer.effect(CodexAppServerClient, makeReplayClientWithState(driver));
}

export const makeReplayClient = Effect.fn("effect-codex-app-server/replay.makeReplayClient")(
  function* (
    transcript: CodexAppServerReplayTranscript,
    options: CodexClient.CodexAppServerClientOptions = {},
  ) {
    const driver = yield* makeReplayDriver(transcript);
    return yield* makeReplayClientWithState(driver, options);
  },
);

const makeReplayClientWithState = Effect.fn(
  "effect-codex-app-server/replay.makeReplayClientWithState",
)(function* (
  driver: CodexAppServerReplayDriver,
  options: CodexClient.CodexAppServerClientOptions = {},
) {
  const transcript = driver.transcript;
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const state = driver.state;
  const outboundRemainder = yield* Ref.make("");

  const failReplay = (error: CodexAppServerReplayError) =>
    Ref.update(state, (current) => ({
      ...current,
      failure: current.failure ?? error,
    })).pipe(Effect.andThen(Queue.end(input)));

  const drainInbound = Effect.fn("effect-codex-app-server/replay.drainInbound")(function* () {
    while (true) {
      const current = yield* Ref.get(state);
      if (current.failure) {
        return;
      }

      const entry = transcript.entries[current.cursor];
      if (!entry) {
        return;
      }

      if (entry.type === "emit_inbound") {
        if (entry.afterMs !== undefined && entry.afterMs > 0) {
          yield* Effect.sleep(Duration.millis(entry.afterMs));
        }
        yield* Queue.offer(input, encodeInboundFrame(entry.frame));
        yield* Ref.update(state, (latest) => ({ ...latest, cursor: latest.cursor + 1 }));
        continue;
      }

      if (entry.type === "runtime_exit") {
        yield* Ref.update(state, (latest) => ({ ...latest, cursor: latest.cursor + 1 }));
        if (entry.status === "success") {
          yield* Queue.end(input);
          return;
        }
        yield* failReplay(
          new CodexAppServerReplayRuntimeExitError({
            scenario: transcript.scenario,
            cursor: current.cursor,
            status: entry.status,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          }),
        );
        return;
      }

      return;
    }
  });

  const processOutboundFrame = (actual: unknown) =>
    drainInbound().pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.failure) {
            return;
          }

          const entry = transcript.entries[current.cursor];
          if (!entry) {
            yield* failReplay(
              new CodexAppServerReplayExhaustedError({
                scenario: transcript.scenario,
                cursor: current.cursor,
                actual,
              }),
            );
            return;
          }

          if (entry.type !== "expect_outbound") {
            yield* failReplay(
              new CodexAppServerReplayUnexpectedOutboundError({
                scenario: transcript.scenario,
                cursor: current.cursor,
                expectedType: entry.type,
                actual,
              }),
            );
            return;
          }

          if (!sameFrame(entry.frame, actual)) {
            yield* failReplay(
              new CodexAppServerReplayFrameMismatchError({
                scenario: transcript.scenario,
                cursor: current.cursor,
                ...(entry.label === undefined ? {} : { label: entry.label }),
                expected: entry.frame,
                actual,
              }),
            );
            return;
          }

          yield* Ref.update(state, (latest) => ({ ...latest, cursor: latest.cursor + 1 }));
          yield* drainInbound();
        }),
      ),
    );

  const processOutboundLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return Effect.void;
    }
    return Effect.try({
      try: () => JSON.parse(trimmed),
      catch: (cause) =>
        new CodexAppServerReplayJsonParseError({
          scenario: transcript.scenario,
          line: trimmed,
          cause,
        }),
    }).pipe(
      Effect.matchEffect({
        onFailure: failReplay,
        onSuccess: processOutboundFrame,
      }),
    );
  };

  const processOutboundChunk = (chunk: string | Uint8Array) =>
    Ref.modify(outboundRemainder, (current) => {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const combined = current + text;
      const lines = combined.split("\n");
      const nextRemainder = lines.pop() ?? "";
      return [lines.map((line) => line.replace(/\r$/, "")), nextRemainder] as const;
    }).pipe(
      Effect.flatMap((lines) => Effect.forEach(lines, processOutboundLine, { discard: true })),
    );

  const terminationError: Effect.Effect<CodexError.CodexAppServerError> = Ref.get(state).pipe(
    Effect.map((current) =>
      current.failure
        ? replayTransportError(transcript, current.failure)
        : new CodexError.CodexAppServerProcessExitedError({ code: 0 }),
    ),
  );

  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(input),
    stdout: () => Sink.forEach(processOutboundChunk),
    stderr: () => Sink.drain,
  });

  yield* drainInbound();

  return yield* CodexClient.make(stdio, options, terminationError);
});

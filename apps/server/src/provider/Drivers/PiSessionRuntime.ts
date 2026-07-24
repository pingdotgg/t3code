import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { PiRpcModel } from "./PiModels.ts";
import { buildPiLaunchPlan, buildPiModelProbeLaunchPlan } from "./PiRuntime.ts";

const PI_RPC_REQUEST_TIMEOUT = "15 seconds" as const;
const PI_RPC_START_TIMEOUT = "30 seconds" as const;
const PI_RPC_FORCE_KILL_AFTER = "2 seconds" as const;
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

export class PiSessionRuntimeError extends Schema.TaggedErrorClass<PiSessionRuntimeError>()(
  "PiSessionRuntimeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

const isPiSessionRuntimeError = Schema.is(PiSessionRuntimeError);

export interface PiSessionRuntimeOptions {
  readonly binaryPath: string;
  readonly configDirectory: string;
  readonly launchArgs: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Both fields are set for a persisted native session and omitted for a model probe. */
  readonly sessionDirectory?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface PiSessionRuntimeState {
  readonly sessionId: string;
  readonly sessionFile?: string | undefined;
  readonly model?: PiRpcModel | undefined;
  readonly thinkingLevel?: string | undefined;
}

export interface PiPromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiPromptInput {
  readonly message: string;
  readonly images?: ReadonlyArray<PiPromptImage> | undefined;
  readonly streamingBehavior?: "steer" | "followUp" | undefined;
}

export type PiExtensionUiResponse =
  | { readonly id: string; readonly value: string }
  | { readonly id: string; readonly confirmed: boolean }
  | { readonly id: string; readonly cancelled: true };

export interface PiSessionRuntimeShape {
  readonly start: () => Effect.Effect<PiSessionRuntimeState, PiSessionRuntimeError>;
  readonly getState: () => Effect.Effect<PiSessionRuntimeState, PiSessionRuntimeError>;
  readonly getAvailableModels: () => Effect.Effect<
    ReadonlyArray<PiRpcModel>,
    PiSessionRuntimeError
  >;
  readonly setModel: (input: {
    readonly provider: string;
    readonly modelId: string;
  }) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly getAvailableThinkingLevels: () => Effect.Effect<
    ReadonlyArray<string>,
    PiSessionRuntimeError
  >;
  readonly setThinkingLevel: (level: string) => Effect.Effect<void, PiSessionRuntimeError>;
  /** Accept a normal Pi RPC prompt; lifecycle events continue asynchronously. */
  readonly prompt: (input: PiPromptInput) => Effect.Effect<void, PiSessionRuntimeError>;
  /** Invoke Pi's native abort command for the active operation. */
  readonly abort: () => Effect.Effect<void, PiSessionRuntimeError>;
  /** Respond to a pending Pi extension UI dialog without awaiting an RPC response. */
  readonly respondToExtensionUI: (
    response: PiExtensionUiResponse,
  ) => Effect.Effect<void, PiSessionRuntimeError>;
  /** Raw Pi protocol events retained for later lifecycle/diagnostic mapping. */
  readonly events: Stream.Stream<unknown>;
  readonly close: Effect.Effect<void>;
}

interface PendingRequest {
  readonly command: string;
  readonly deferred: Deferred.Deferred<unknown, PiSessionRuntimeError>;
}

interface PiRpcResponse {
  readonly id: string;
  readonly command?: string | undefined;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string | undefined;
}

/**
 * Strict LF-delimited JSONL decoder for Pi RPC stdout.
 *
 * Pi permits Unicode line separators inside JSON payloads, so this must not
 * use `readline`, `Stream.splitLines`, or any other generic line reader.
 */
export interface PiJsonlDecoder {
  readonly push: (chunk: string) => ReadonlyArray<string>;
  readonly end: () => ReadonlyArray<string>;
}

export function makePiJsonlDecoder(): PiJsonlDecoder {
  let buffer = "";

  const normalize = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

  return {
    push(chunk) {
      buffer += chunk;
      const records: string[] = [];
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return records;
        }
        records.push(normalize(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    },
    end() {
      if (buffer.length === 0) {
        return [];
      }
      const record = normalize(buffer);
      buffer = "";
      return [record];
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseModel(value: unknown): PiRpcModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = stringValue(value.provider);
  const id = stringValue(value.id);
  if (!provider || !id) {
    return undefined;
  }
  return {
    provider,
    id,
    name: stringValue(value.name) ?? id,
  };
}

function parseState(value: unknown): PiSessionRuntimeState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sessionId = stringValue(value.sessionId);
  if (!sessionId) {
    return undefined;
  }
  const model = parseModel(value.model);
  const sessionFile = stringValue(value.sessionFile);
  const thinkingLevel = stringValue(value.thinkingLevel);
  return {
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function parseResponse(value: unknown): PiRpcResponse | undefined {
  if (!isRecord(value) || value.type !== "response") {
    return undefined;
  }
  const id = stringValue(value.id);
  if (!id || typeof value.success !== "boolean") {
    return undefined;
  }
  const command = stringValue(value.command);
  const error = stringValue(value.error);
  return {
    id,
    success: value.success,
    ...(command ? { command } : {}),
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
    ...(error ? { error } : {}),
  };
}

function resolveLaunchPlan(input: PiSessionRuntimeOptions) {
  const hasSessionDirectory = input.sessionDirectory !== undefined;
  const hasSessionId = input.sessionId !== undefined;
  if (hasSessionDirectory !== hasSessionId) {
    return {
      _tag: "Failure" as const,
      message: "Pi session directory and session ID must be configured together.",
    };
  }
  if (input.sessionDirectory !== undefined && input.sessionId !== undefined) {
    return buildPiLaunchPlan({
      configDirectory: input.configDirectory,
      launchArgs: input.launchArgs,
      sessionDirectory: input.sessionDirectory,
      sessionId: input.sessionId,
    });
  }
  return buildPiModelProbeLaunchPlan({
    configDirectory: input.configDirectory,
    launchArgs: input.launchArgs,
  });
}

export const makePiSessionRuntime = (
  options: PiSessionRuntimeOptions,
): Effect.Effect<
  PiSessionRuntimeShape,
  PiSessionRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const launchPlan = resolveLaunchPlan(options);
    if (launchPlan._tag === "Failure") {
      return yield* new PiSessionRuntimeError({
        operation: "build-launch-plan",
        detail: launchPlan.message,
      });
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const environment = {
      ...options.environment,
      ...launchPlan.environment,
    };
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, launchPlan.args, {
      env: environment,
      extendEnv: true,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env: environment,
          extendEnv: true,
          forceKillAfter: PI_RPC_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
          stdin: { stream: "pipe", endOnDone: false },
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new PiSessionRuntimeError({
              operation: "spawn",
              detail: `Could not start '${options.binaryPath}' in RPC mode.`,
              cause,
            }),
        ),
      );

    const pendingRequests = yield* Ref.make(new Map<string, PendingRequest>());
    const requestNumber = yield* Ref.make(0);
    const writeLock = yield* Semaphore.make(1);
    const rawEvents = yield* Queue.unbounded<unknown>();
    const closed = yield* Ref.make(false);
    const decoder = makePiJsonlDecoder();

    const failPendingRequests = (error: PiSessionRuntimeError) =>
      Ref.getAndSet(pendingRequests, new Map<string, PendingRequest>()).pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(
            Array.from(pending.values()),
            (request) => Deferred.fail(request.deferred, error).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const removePendingRequest = (id: string) =>
      Ref.update(pendingRequests, (pending) => {
        if (!pending.has(id)) {
          return pending;
        }
        const next = new Map(pending);
        next.delete(id);
        return next;
      });

    const handleResponse = (response: PiRpcResponse) =>
      Ref.modify(pendingRequests, (pending) => {
        const request = pending.get(response.id);
        if (!request) {
          return [undefined, pending] as const;
        }
        const next = new Map(pending);
        next.delete(response.id);
        return [request, next] as const;
      }).pipe(
        Effect.flatMap((request) => {
          if (!request) {
            return Effect.void;
          }
          if (response.success) {
            return Deferred.succeed(request.deferred, response.data).pipe(Effect.asVoid);
          }
          return Deferred.fail(
            request.deferred,
            new PiSessionRuntimeError({
              operation: request.command,
              detail: response.error ?? "Pi rejected the RPC command.",
            }),
          ).pipe(Effect.asVoid);
        }),
      );

    const handleRecord = (record: string) => {
      if (record.length === 0) {
        return Effect.void;
      }
      return decodeUnknownJson(record).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Queue.offer(rawEvents, {
              type: "pi_rpc_invalid_json",
              raw: record,
            }).pipe(Effect.asVoid),
          onSuccess: (value) => {
            const response = parseResponse(value);
            return response
              ? handleResponse(response)
              : Queue.offer(rawEvents, value).pipe(Effect.asVoid);
          },
        }),
      );
    };

    const flushDecoder = () =>
      Effect.forEach(decoder.end(), handleRecord, { discard: true }).pipe(Effect.asVoid);

    const outputFiber = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.forEach(decoder.push(chunk), handleRecord, { discard: true }).pipe(Effect.asVoid),
      ),
      Effect.ensuring(flushDecoder()),
      Effect.catch(() =>
        failPendingRequests(
          new PiSessionRuntimeError({
            operation: "read-stdout",
            detail: "Pi RPC stdout closed unexpectedly.",
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    // Drain stderr even before lifecycle mapping/diagnostics is enabled. An
    // unread stderr pipe can otherwise block an otherwise healthy Pi process.
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(runtimeScope));

    yield* child.exitCode.pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          failPendingRequests(
            new PiSessionRuntimeError({
              operation: "process-exit",
              detail: "Could not read Pi process exit status.",
              cause,
            }),
          ),
        onSuccess: (code) =>
          failPendingRequests(
            new PiSessionRuntimeError({
              operation: "process-exit",
              detail:
                code === 0
                  ? "Pi RPC process exited."
                  : `Pi RPC process exited with code ${String(code)}.`,
            }),
          ),
      }),
      Effect.andThen(Queue.shutdown(rawEvents)),
      Effect.forkIn(runtimeScope),
    );

    const writeCommand = (record: Record<string, unknown>) =>
      encodeUnknownJson(record).pipe(
        Effect.mapError(
          (cause) =>
            new PiSessionRuntimeError({
              operation: "encode-command",
              detail: "Could not encode Pi RPC command.",
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          writeLock.withPermit(
            Stream.run(Stream.encodeText(Stream.make(`${encoded}\n`)), child.stdin),
          ),
        ),
        Effect.mapError((cause) =>
          isPiSessionRuntimeError(cause)
            ? cause
            : new PiSessionRuntimeError({
                operation: "write-stdin",
                detail: "Could not write Pi RPC command.",
                cause,
              }),
        ),
      );

    const request = Effect.fn("PiSessionRuntime.request")(function* (
      command: Record<string, unknown>,
      timeout = PI_RPC_REQUEST_TIMEOUT,
    ) {
      const closedNow = yield* Ref.get(closed);
      if (closedNow) {
        return yield* new PiSessionRuntimeError({
          operation: String(command.type ?? "command"),
          detail: "Pi RPC session is closed.",
        });
      }

      const sequence = yield* Ref.modify(requestNumber, (current) => [current + 1, current + 1]);
      const id = `t3-pi-${sequence}`;
      const deferred = yield* Deferred.make<unknown, PiSessionRuntimeError>();
      const commandName = String(command.type ?? "command");
      yield* Ref.update(pendingRequests, (pending) => {
        const next = new Map(pending);
        next.set(id, { command: commandName, deferred });
        return next;
      });

      yield* writeCommand({ ...command, id }).pipe(Effect.onError(() => removePendingRequest(id)));

      const response = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              removePendingRequest(id).pipe(
                Effect.andThen(
                  new PiSessionRuntimeError({
                    operation: commandName,
                    detail: `Timed out waiting for Pi RPC response after ${timeout}.`,
                  }),
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      return response;
    });

    const getState = (timeout = PI_RPC_REQUEST_TIMEOUT) =>
      request({ type: "get_state" }, timeout).pipe(
        Effect.flatMap((response) => {
          const state = parseState(response);
          return state
            ? Effect.succeed(state)
            : Effect.fail(
                new PiSessionRuntimeError({
                  operation: "get_state",
                  detail: "Pi returned an invalid session state response.",
                }),
              );
        }),
      );

    const start = () =>
      getState(PI_RPC_START_TIMEOUT).pipe(
        Effect.flatMap((state) => {
          if (options.sessionId !== undefined && state.sessionId !== options.sessionId) {
            return Effect.fail(
              new PiSessionRuntimeError({
                operation: "get_state",
                detail: `Pi started session '${state.sessionId}' instead of required session '${options.sessionId}'.`,
              }),
            );
          }
          return Effect.succeed(state);
        }),
      );

    const getAvailableModels = () =>
      request({ type: "get_available_models" }).pipe(
        Effect.flatMap((response) => {
          if (!isRecord(response) || !Array.isArray(response.models)) {
            return Effect.fail(
              new PiSessionRuntimeError({
                operation: "get_available_models",
                detail: "Pi returned an invalid model catalog response.",
              }),
            );
          }
          return Effect.succeed(
            response.models.flatMap((model) => {
              const parsed = parseModel(model);
              return parsed ? [parsed] : [];
            }),
          );
        }),
      );

    const setModel = (input: { readonly provider: string; readonly modelId: string }) =>
      request({
        type: "set_model",
        provider: input.provider,
        modelId: input.modelId,
      }).pipe(Effect.asVoid);

    const getAvailableThinkingLevels = () =>
      request({ type: "get_available_thinking_levels" }).pipe(
        Effect.flatMap((response) => {
          if (!isRecord(response) || !Array.isArray(response.levels)) {
            return Effect.fail(
              new PiSessionRuntimeError({
                operation: "get_available_thinking_levels",
                detail: "Pi returned an invalid thinking-level response.",
              }),
            );
          }
          const seen = new Set<string>();
          const levels: string[] = [];
          for (const value of response.levels) {
            const level = stringValue(value);
            if (!level || seen.has(level)) {
              continue;
            }
            seen.add(level);
            levels.push(level);
          }
          return Effect.succeed(levels);
        }),
      );

    const setThinkingLevel = (level: string) =>
      request({ type: "set_thinking_level", level }).pipe(Effect.asVoid);

    const prompt = (input: PiPromptInput) =>
      request({
        type: "prompt",
        message: input.message,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
      }).pipe(Effect.asVoid);

    const abort = () => request({ type: "abort" }).pipe(Effect.asVoid);

    const respondToExtensionUI = Effect.fn("PiSessionRuntime.respondToExtensionUI")(function* (
      response: PiExtensionUiResponse,
    ) {
      const closedNow = yield* Ref.get(closed);
      if (closedNow) {
        return yield* new PiSessionRuntimeError({
          operation: "extension_ui_response",
          detail: "Pi RPC session is closed.",
        });
      }
      yield* writeCommand({ type: "extension_ui_response", ...response });
    });

    const close = Ref.getAndSet(closed, true).pipe(
      Effect.flatMap((wasClosed) => {
        if (wasClosed) {
          return Effect.void;
        }
        return child.kill({ forceKillAfter: PI_RPC_FORCE_KILL_AFTER }).pipe(
          Effect.ignore,
          Effect.andThen(
            failPendingRequests(
              new PiSessionRuntimeError({
                operation: "close",
                detail: "Pi RPC session was closed.",
              }),
            ),
          ),
          Effect.andThen(Queue.shutdown(rawEvents)),
        );
      }),
    );

    yield* Effect.addFinalizer(() => close);

    // Keep the stdout fibre reachable through the runtime scope. The binding
    // is intentionally retained to make the ownership explicit.
    void outputFiber;

    return {
      start,
      getState,
      getAvailableModels,
      setModel,
      getAvailableThinkingLevels,
      setThinkingLevel,
      prompt,
      abort,
      respondToExtensionUI,
      events: Stream.fromQueue(rawEvents),
      close,
    } satisfies PiSessionRuntimeShape;
  });

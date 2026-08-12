// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  OrchestrationCommandDeduplicationWindowChangedError,
  OrchestrationDispatchCommandError,
  OrchestrationTurnStartPendingError,
  type ClientOrchestrationCommand,
  type CommandId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";

const COMPLETED_COMMAND_LIMIT = 1_024;
const PROCESS_LOCAL_COMMAND_LIMIT = 256;
const LARGE_STRING_HASH_CHUNK_CODE_UNITS = 256 * 1_024;
const isOrchestrationTurnStartPendingError = Schema.is(OrchestrationTurnStartPendingError);

type CommandExecutionError =
  | OrchestrationCommandDeduplicationWindowChangedError
  | OrchestrationDispatchCommandError
  | OrchestrationTurnStartPendingError;

interface CommandExecution {
  readonly result: Deferred.Deferred<CommandResult, CommandExecutionError>;
  readonly fingerprint: string;
  readonly completed: boolean;
  readonly processLocal: boolean;
}

interface CommandResult {
  readonly sequence: number;
}

interface ExecutionState {
  readonly executions: ReadonlyMap<CommandId, CommandExecution>;
  readonly processLocalCommandIds: ReadonlySet<CommandId>;
  readonly runId: string;
}

function trimCompletedExecutions(
  executions: Map<CommandId, CommandExecution>,
  maxSize: number,
): void {
  while (executions.size > maxSize) {
    const completed = Array.from(executions).find(
      ([, entry]) => entry.completed && !entry.processLocal,
    );
    if (!completed) break;
    executions.delete(completed[0]);
  }
}

export class ClientCommandExecution extends Context.Service<
  ClientCommandExecution,
  {
    readonly runId: Effect.Effect<string>;
    readonly run: (
      commandId: CommandId,
      options: {
        readonly fingerprint: string;
        readonly processLocal?: boolean;
        readonly expectedRunId?: string;
      },
    ) => <R>(
      effect: Effect.Effect<
        CommandResult,
        OrchestrationDispatchCommandError | OrchestrationTurnStartPendingError,
        R
      >,
    ) => Effect.Effect<CommandResult, CommandExecutionError, R>;
  }
>()("t3/orchestration/ClientCommandExecution") {}

function updateLengthPrefixedString(hash: NodeCrypto.Hash, value: string): void {
  // Preserve every JavaScript code unit; UTF-8 replaces distinct lone surrogates identically.
  hash.update(String(value.length)).update(":").update(value, "utf16le");
}

function updateCanonicalValue(hash: NodeCrypto.Hash, value: unknown): void {
  if (value === null) {
    hash.update("N");
    return;
  }
  if (typeof value === "string") {
    hash.update("S");
    updateLengthPrefixedString(hash, value);
    return;
  }
  if (typeof value === "number") {
    hash.update("D");
    updateLengthPrefixedString(hash, String(value));
    return;
  }
  if (typeof value === "boolean") {
    hash.update(value ? "T" : "F");
    return;
  }
  if (Array.isArray(value)) {
    hash.update("A");
    updateLengthPrefixedString(hash, String(value.length));
    for (const entry of value) updateCanonicalValue(hash, entry);
    return;
  }
  if (value instanceof Uint8Array) {
    hash.update("B");
    updateLengthPrefixedString(hash, String(value.byteLength));
    hash.update(value);
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    hash.update("O");
    updateLengthPrefixedString(hash, String(entries.length));
    for (const [key, entry] of entries) {
      updateLengthPrefixedString(hash, key);
      updateCanonicalValue(hash, entry);
    }
    return;
  }
  hash.update("U");
}

const hashStringCooperatively = Effect.fn("ClientCommandExecution.hashStringCooperatively")(
  function* (value: string) {
    const hash = NodeCrypto.createHash("sha256");
    for (let offset = 0; offset < value.length; offset += LARGE_STRING_HASH_CHUNK_CODE_UNITS) {
      hash.update(value.slice(offset, offset + LARGE_STRING_HASH_CHUNK_CODE_UNITS), "utf16le");
      if (offset + LARGE_STRING_HASH_CHUNK_CODE_UNITS < value.length) {
        yield* Effect.yieldNow;
      }
    }
    return hash.digest("hex");
  },
);

export const fingerprintClientCommand = Effect.fn(
  "ClientCommandExecution.fingerprintClientCommand",
)(function* (command: ClientOrchestrationCommand) {
  const fingerprintInput =
    command.type === "thread.turn.start" && command.expectedServerRunId !== undefined
      ? { ...command, expectedServerRunId: undefined }
      : command;
  const cooperativeInput =
    fingerprintInput.type === "thread.turn.start" && fingerprintInput.message.attachments.length > 0
      ? {
          ...fingerprintInput,
          message: {
            ...fingerprintInput.message,
            attachments: yield* Effect.forEach(
              fingerprintInput.message.attachments,
              (attachment) =>
                hashStringCooperatively(attachment.dataUrl).pipe(
                  Effect.map((dataUrlSha256) => ({
                    ...attachment,
                    dataUrl: undefined,
                    dataUrlFingerprint: {
                      algorithm: "sha256-utf16le-v1",
                      codeUnits: attachment.dataUrl.length,
                      digest: dataUrlSha256,
                    },
                  })),
                ),
              { concurrency: 1 },
            ),
          },
        }
      : fingerprintInput;
  const hash = NodeCrypto.createHash("sha256");
  updateCanonicalValue(hash, cooperativeInput);
  return hash.digest("hex");
});

export const make = Effect.gen(function* () {
  const executionScope = yield* Scope.make();
  const state = yield* Ref.make<ExecutionState>({
    executions: new Map(),
    processLocalCommandIds: new Set(),
    runId: NodeCrypto.randomUUID(),
  });
  yield* Effect.addFinalizer(() => Scope.close(executionScope, Exit.void));

  const run: ClientCommandExecution["Service"]["run"] = (commandId, options) => (effect) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<CommandResult, CommandExecutionError>();
        const registration = yield* Ref.modify(
          state,
          (
            current,
          ): readonly [
            {
              readonly owner: boolean;
              readonly result: CommandExecution["result"];
              readonly rejection?: CommandExecutionError;
            },
            ExecutionState,
          ] => {
            const existing = current.executions.get(commandId);
            if (existing) {
              if (existing.fingerprint !== options.fingerprint) {
                return [
                  {
                    owner: false,
                    result: candidate,
                    rejection: new OrchestrationDispatchCommandError({
                      message: "The command ID was reused with a different command payload.",
                    }),
                  },
                  current,
                ];
              }
              return [{ owner: false, result: existing.result }, current];
            }

            if (options?.expectedRunId !== undefined && options.expectedRunId !== current.runId) {
              return [
                {
                  owner: false,
                  result: candidate,
                  rejection: new OrchestrationCommandDeduplicationWindowChangedError({}),
                },
                current,
              ];
            }

            const executions = new Map(current.executions);
            const processLocalCommandIds = new Set(current.processLocalCommandIds);
            let runId = current.runId;
            if (options?.processLocal === true) {
              processLocalCommandIds.add(commandId);
              while (processLocalCommandIds.size > PROCESS_LOCAL_COMMAND_LIMIT) {
                const oldest = processLocalCommandIds.values().next().value;
                if (oldest === undefined) break;
                processLocalCommandIds.delete(oldest);
                const entry = executions.get(oldest);
                if (entry) {
                  executions.set(oldest, { ...entry, processLocal: false });
                }
                // A replacement socket must fail conservatively once an older
                // process-local receipt can no longer be deduplicated.
                runId = NodeCrypto.randomUUID();
              }
            }
            trimCompletedExecutions(executions, COMPLETED_COMMAND_LIMIT - 1);
            executions.set(commandId, {
              result: candidate,
              fingerprint: options.fingerprint,
              completed: false,
              processLocal: options?.processLocal === true,
            });
            return [
              { owner: true, result: candidate },
              { executions, processLocalCommandIds, runId },
            ];
          },
        );

        if (registration.rejection) {
          return yield* registration.rejection;
        }

        if (registration.owner) {
          yield* Effect.forkIn(
            Effect.exit(restore(effect)).pipe(
              Effect.flatMap((exit) =>
                Ref.update(state, (current) => {
                  const existing = current.executions.get(commandId);
                  if (!existing || existing.result !== candidate) return current;
                  const executions = new Map(current.executions);
                  if (
                    Exit.isFailure(exit) &&
                    exit.cause.reasons.some(
                      (reason) =>
                        reason._tag === "Fail" &&
                        isOrchestrationTurnStartPendingError(reason.error),
                    )
                  ) {
                    executions.delete(commandId);
                    return { ...current, executions };
                  }
                  executions.set(commandId, {
                    result: candidate,
                    fingerprint: options.fingerprint,
                    completed: true,
                    processLocal: current.processLocalCommandIds.has(commandId),
                  });
                  trimCompletedExecutions(executions, COMPLETED_COMMAND_LIMIT);
                  return { ...current, executions };
                }).pipe(Effect.andThen(Deferred.done(candidate, exit)), Effect.uninterruptible),
              ),
              Effect.ensuring(
                Ref.update(state, (current) => {
                  const existing = current.executions.get(commandId);
                  if (!existing || existing.result !== candidate || existing.completed) {
                    return current;
                  }
                  const executions = new Map(current.executions);
                  executions.delete(commandId);
                  return { ...current, executions };
                }),
              ),
            ),
            executionScope,
            { startImmediately: true },
          );
        }

        return yield* restore(Deferred.await(registration.result));
      }),
    );

  return ClientCommandExecution.of({
    runId: Ref.get(state).pipe(Effect.map((value) => value.runId)),
    run,
  });
});

export const layer = Layer.effect(ClientCommandExecution, make);

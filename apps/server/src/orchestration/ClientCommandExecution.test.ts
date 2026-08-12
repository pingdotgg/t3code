import {
  CommandId,
  MessageId,
  OrchestrationCommandDeduplicationWindowChangedError,
  OrchestrationDispatchCommandError,
  OrchestrationTurnStartPendingError,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import {
  ClientCommandExecution,
  fingerprintClientCommand,
  make,
} from "./ClientCommandExecution.ts";

function asTestCommandExecution(service: ClientCommandExecution["Service"]) {
  return {
    ...service,
    run: (
      commandId: CommandId,
      options?: {
        readonly fingerprint?: string;
        readonly processLocal?: boolean;
        readonly expectedRunId?: string;
      },
    ) =>
      service.run(commandId, {
        ...options,
        fingerprint: options?.fingerprint ?? commandId,
      }),
  };
}

describe("ClientCommandExecution", () => {
  it.effect("fingerprints decoded command payloads canonically", () =>
    Effect.gen(function* () {
      const commandId = CommandId.make("command-fingerprint");
      const threadId = ThreadId.make("thread-fingerprint");
      const command: ClientOrchestrationCommand = {
        type: "thread.archive",
        commandId,
        threadId,
      };
      const reordered: ClientOrchestrationCommand = {
        threadId,
        commandId,
        type: "thread.archive",
      };

      expect(yield* fingerprintClientCommand(command)).toBe(
        yield* fingerprintClientCommand(reordered),
      );
      expect(yield* fingerprintClientCommand(command)).not.toBe(
        yield* fingerprintClientCommand({ ...command, threadId: ThreadId.make("thread-other") }),
      );
    }),
  );

  it.effect("ignores only the replay-added server run id in command fingerprints", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-bootstrap-fingerprint"),
        threadId: ThreadId.make("thread-bootstrap-fingerprint"),
        message: {
          messageId: MessageId.make("message-bootstrap-fingerprint"),
          role: "user",
          text: "hello",
          attachments: [
            {
              type: "image",
              name: "image.bin",
              mimeType: "image/example",
              sizeBytes: 3,
              dataUrl: "data:image/example;base64,b25l",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: { runSetupScript: true },
        createdAt: "2026-08-12T00:00:00.000Z",
      };

      expect(yield* fingerprintClientCommand(command)).toBe(
        yield* fingerprintClientCommand({ ...command, expectedServerRunId: "server-run-1" }),
      );
      expect(yield* fingerprintClientCommand(command)).not.toBe(
        yield* fingerprintClientCommand({
          ...command,
          message: { ...command.message, text: "different" },
        }),
      );
      expect(yield* fingerprintClientCommand(command)).not.toBe(
        yield* fingerprintClientCommand({
          ...command,
          message: {
            ...command.message,
            attachments: [
              { ...command.message.attachments[0]!, dataUrl: "data:image/example;base64,dHdv" },
            ],
          },
        }),
      );
      expect(
        yield* fingerprintClientCommand({
          ...command,
          message: { ...command.message, text: String.fromCharCode(0xd800) },
        }),
      ).not.toBe(
        yield* fingerprintClientCommand({
          ...command,
          message: { ...command.message, text: String.fromCharCode(0xd801) },
        }),
      );
    }),
  );

  it.effect("yields while fingerprinting large attachment payloads", () =>
    Effect.gen(function* () {
      const heartbeats = yield* Ref.make(0);
      const heartbeatStarted = yield* Deferred.make<void>();
      const heartbeat = yield* Ref.updateAndGet(heartbeats, (count) => count + 1).pipe(
        Effect.tap((count) =>
          count === 1 ? Deferred.succeed(heartbeatStarted, undefined) : Effect.void,
        ),
        Effect.andThen(Effect.yieldNow),
        Effect.forever,
        Effect.forkChild,
      );
      yield* Deferred.await(heartbeatStarted);
      const before = yield* Ref.get(heartbeats);
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-large-attachment-fingerprint"),
        threadId: ThreadId.make("thread-large-attachment-fingerprint"),
        message: {
          messageId: MessageId.make("message-large-attachment-fingerprint"),
          role: "user",
          text: "large attachment",
          attachments: [
            {
              type: "image",
              name: "large.bin",
              mimeType: "image/example",
              sizeBytes: 1024 * 1024,
              dataUrl: `data:image/example;base64,${"A".repeat(1024 * 1024)}`,
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-12T00:00:00.000Z",
      };

      yield* fingerprintClientCommand(command);
      expect(yield* Ref.get(heartbeats)).toBeGreaterThan(before);
      yield* Fiber.interrupt(heartbeat);
    }),
  );

  it.effect("keeps a command running across a disconnected waiter and shares its result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executions = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const commandExecution = asTestCommandExecution(yield* make);
        const commandId = CommandId.make("command-reconnect");
        const execute = Ref.update(executions, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as({ sequence: 42 }),
        );

        const disconnectedWaiter = yield* commandExecution
          .run(commandId)(execute)
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(disconnectedWaiter);

        const replacementWaiter = yield* commandExecution
          .run(commandId)(execute)
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);

        expect(yield* Fiber.join(replacementWaiter)).toEqual({ sequence: 42 });
        expect(yield* Ref.get(executions)).toBe(1);
        expect(yield* commandExecution.run(commandId)(Effect.die("duplicate executed"))).toEqual({
          sequence: 42,
        });
      }),
    ),
  );

  it.effect("shares and caches a failed command until the completed cache evicts it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executions = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const commandExecution = asTestCommandExecution(yield* make);
        const commandId = CommandId.make("command-cached-failure");
        const failure = new OrchestrationDispatchCommandError({ message: "temporary failure" });
        const failOnce = Ref.update(executions, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.fail(failure)),
        );
        const joinFailure = commandExecution
          .run(commandId, { fingerprint: "failed-payload" })(failOnce)
          .pipe(Effect.exit);

        const first = yield* joinFailure.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* joinFailure.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(executions)).toBe(1);
        yield* Deferred.succeed(release, undefined);

        const firstExit = yield* Fiber.join(first);
        expect(firstExit).toEqual(Exit.fail(failure));
        if (Exit.isFailure(firstExit)) {
          expect(Cause.squash(firstExit.cause)).toBe(failure);
        }
        expect(yield* Fiber.join(second)).toEqual(firstExit);
        expect(yield* Ref.get(executions)).toBe(1);

        const replayExit = yield* commandExecution
          .run(commandId, { fingerprint: "failed-payload" })(
            Ref.update(executions, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("cached failure reran")),
            ),
          )
          .pipe(Effect.exit);
        expect(replayExit).toEqual(firstExit);
        if (Exit.isFailure(replayExit)) {
          expect(Cause.squash(replayExit.cause)).toBe(failure);
        }
        expect(yield* Ref.get(executions)).toBe(1);

        const conflict = yield* commandExecution
          .run(commandId, { fingerprint: "different-payload" })(
            Ref.update(executions, (count) => count + 1).pipe(Effect.as({ sequence: 43 })),
          )
          .pipe(Effect.flip);
        expect(conflict.message).toContain("different command payload");
        expect(yield* Ref.get(executions)).toBe(1);

        for (let index = 0; index < 1_024; index += 1) {
          yield* commandExecution.run(CommandId.make(`ordinary-after-failure-${index}`))(
            Effect.succeed({ sequence: index + 44 }),
          );
        }

        expect(
          yield* commandExecution.run(commandId, { fingerprint: "failed-payload" })(
            Ref.update(executions, (count) => count + 1).pipe(Effect.as({ sequence: 43 })),
          ),
        ).toEqual({ sequence: 43 });
        expect(yield* Ref.get(executions)).toBe(2);
      }),
    ),
  );

  it.effect("shares a transient pending result in flight and re-executes its exact retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executions = yield* Ref.make(0);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const commandExecution = asTestCommandExecution(yield* make);
        const commandId = CommandId.make("command-transient-turn-pending");
        const failure = new OrchestrationTurnStartPendingError({
          threadId: ThreadId.make("thread-transient-turn-pending"),
        });
        const failPending = Ref.update(executions, (count) => count + 1).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.fail(failure)),
        );
        const runPending = commandExecution
          .run(commandId, { fingerprint: "pending-payload" })(failPending)
          .pipe(Effect.exit);

        const first = yield* runPending.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* runPending.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(executions)).toBe(1);
        yield* Deferred.succeed(release, undefined);

        const firstExit = yield* Fiber.join(first);
        expect(firstExit).toEqual(Exit.fail(failure));
        expect(yield* Fiber.join(second)).toEqual(firstExit);
        expect(yield* Ref.get(executions)).toBe(1);

        expect(
          yield* commandExecution.run(commandId, { fingerprint: "pending-payload" })(
            Ref.update(executions, (count) => count + 1).pipe(Effect.as({ sequence: 43 })),
          ),
        ).toEqual({ sequence: 43 });
        expect(yield* Ref.get(executions)).toBe(2);
      }),
    ),
  );

  it.effect("rejects command ID reuse with a different payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commandExecution = asTestCommandExecution(yield* make);
        const commandId = CommandId.make("command-payload-conflict");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const conflictingExecutions = yield* Ref.make(0);
        const first = yield* commandExecution
          .run(commandId, { fingerprint: "first-payload" })(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ sequence: 44 }),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        const inFlightConflict = yield* commandExecution
          .run(commandId, { fingerprint: "different-payload" })(
            Ref.update(conflictingExecutions, (count) => count + 1).pipe(
              Effect.as({ sequence: 45 }),
            ),
          )
          .pipe(Effect.flip);
        expect(inFlightConflict.message).toContain("different command payload");
        expect(yield* Ref.get(conflictingExecutions)).toBe(0);

        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toEqual({ sequence: 44 });
        const completedConflict = yield* commandExecution
          .run(commandId, { fingerprint: "different-payload" })(
            Ref.update(conflictingExecutions, (count) => count + 1).pipe(
              Effect.as({ sequence: 46 }),
            ),
          )
          .pipe(Effect.flip);
        expect(completedConflict.message).toContain("different command payload");
        expect(yield* Ref.get(conflictingExecutions)).toBe(0);
      }),
    ),
  );

  it.effect("retains completed process-local commands beyond the ordinary cache limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commandExecution = asTestCommandExecution(yield* make);
        const processLocalId = CommandId.make("command-process-local");
        const executions = yield* Ref.make(0);
        const execute = Ref.update(executions, (count) => count + 1).pipe(
          Effect.as({ sequence: 1 }),
        );

        expect(
          yield* commandExecution.run(processLocalId, { processLocal: true })(execute),
        ).toEqual({ sequence: 1 });
        for (let index = 0; index < 1_100; index += 1) {
          yield* commandExecution.run(CommandId.make(`ordinary-${index}`))(
            Effect.succeed({ sequence: index + 2 }),
          );
        }

        expect(
          yield* commandExecution.run(processLocalId)(Effect.die("process-local result evicted")),
        ).toEqual({ sequence: 1 });
        expect(yield* Ref.get(executions)).toBe(1);
      }),
    ),
  );

  it.effect("rotates the run id when a retained process-local command is evicted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commandExecution = asTestCommandExecution(yield* make);
        const initialRunId = yield* commandExecution.runId;
        for (let index = 0; index < 257; index += 1) {
          yield* commandExecution.run(CommandId.make(`process-local-${index}`), {
            processLocal: true,
          })(Effect.succeed({ sequence: index }));
        }
        expect(yield* commandExecution.runId).not.toBe(initialRunId);
        for (let index = 0; index < 800; index += 1) {
          yield* commandExecution.run(CommandId.make(`ordinary-after-process-local-${index}`))(
            Effect.succeed({ sequence: 300 + index }),
          );
        }

        expect(
          yield* commandExecution.run(CommandId.make("process-local-0"))(
            Effect.succeed({ sequence: 999 }),
          ),
        ).toEqual({ sequence: 999 });
        expect(
          yield* commandExecution.run(CommandId.make("process-local-256"))(
            Effect.die("newest process-local result evicted"),
          ),
        ).toEqual({ sequence: 256 });
      }),
    ),
  );

  it.effect("rejects a stale process-local epoch without executing the command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commandExecution = asTestCommandExecution(yield* make);
        const initialRunId = yield* commandExecution.runId;
        for (let index = 0; index < 257; index += 1) {
          yield* commandExecution.run(CommandId.make(`stale-process-local-${index}`), {
            processLocal: true,
          })(Effect.succeed({ sequence: index }));
        }
        for (let index = 0; index < 800; index += 1) {
          yield* commandExecution.run(CommandId.make(`ordinary-before-stale-${index}`))(
            Effect.succeed({ sequence: 300 + index }),
          );
        }

        const executions = yield* Ref.make(0);
        const result = yield* commandExecution
          .run(CommandId.make("stale-process-local-0"), {
            processLocal: true,
            expectedRunId: initialRunId,
          })(Ref.update(executions, (count) => count + 1).pipe(Effect.as({ sequence: 999 })))
          .pipe(Effect.flip);

        expect(result.message).toContain("deduplication window changed");
        expect(result).toBeInstanceOf(OrchestrationCommandDeduplicationWindowChangedError);
        expect(result._tag).toBe("OrchestrationCommandDeduplicationWindowChangedError");
        expect(yield* Ref.get(executions)).toBe(0);
      }),
    ),
  );

  it.effect("returns a retained receipt after the process-local run id rotates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commandExecution = asTestCommandExecution(yield* make);
        const commandId = CommandId.make("retained-before-run-id-rotation");
        const initialRunId = yield* commandExecution.runId;
        expect(
          yield* commandExecution.run(commandId, {
            fingerprint: "retained-payload",
            processLocal: true,
          })(Effect.succeed({ sequence: 71 })),
        ).toEqual({ sequence: 71 });

        for (let index = 0; index < 256; index += 1) {
          yield* commandExecution.run(CommandId.make(`rotate-after-retained-${index}`), {
            processLocal: true,
          })(Effect.succeed({ sequence: index + 72 }));
        }
        expect(yield* commandExecution.runId).not.toBe(initialRunId);

        expect(
          yield* commandExecution.run(commandId, {
            fingerprint: "retained-payload",
            processLocal: true,
            expectedRunId: initialRunId,
          })(Effect.die("retained receipt executed twice")),
        ).toEqual({ sequence: 71 });
      }),
    ),
  );

  it.effect("rotates the run id when concurrent process-local registrations exceed the bound", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commandExecution = asTestCommandExecution(yield* make);
        const initialRunId = yield* commandExecution.runId;
        const release = yield* Deferred.make<void>();
        const firstId = CommandId.make("concurrent-process-local-0");
        const fibers: Array<
          Fiber.Fiber<
            { sequence: number },
            | OrchestrationCommandDeduplicationWindowChangedError
            | OrchestrationDispatchCommandError
            | OrchestrationTurnStartPendingError
          >
        > = [];

        for (let index = 0; index < 257; index += 1) {
          fibers.push(
            yield* commandExecution
              .run(CommandId.make(`concurrent-process-local-${index}`), {
                processLocal: true,
              })(Deferred.await(release).pipe(Effect.as({ sequence: index })))
              .pipe(Effect.forkChild),
          );
        }
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join, { discard: true });
        expect(yield* commandExecution.runId).not.toBe(initialRunId);
        for (let index = 0; index < 800; index += 1) {
          yield* commandExecution.run(CommandId.make(`ordinary-after-concurrent-${index}`))(
            Effect.succeed({ sequence: 300 + index }),
          );
        }

        expect(yield* commandExecution.run(firstId)(Effect.succeed({ sequence: 999 }))).toEqual({
          sequence: 999,
        });
        expect(
          yield* commandExecution.run(CommandId.make("concurrent-process-local-256"))(
            Effect.die("newest concurrent result evicted"),
          ),
        ).toEqual({ sequence: 256 });
      }),
    ),
  );

  it.effect("trims the completed cache after a concurrent command burst", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commandExecution = asTestCommandExecution(yield* make);
        const release = yield* Deferred.make<void>();
        const fibers = yield* Effect.forEach(
          Array.from({ length: 1_100 }, (_, index) => index),
          (index) =>
            commandExecution
              .run(CommandId.make(`concurrent-ordinary-${index}`))(
                Deferred.await(release).pipe(Effect.as({ sequence: index })),
              )
              .pipe(Effect.forkChild),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join, { discard: true });

        expect(
          yield* commandExecution.run(CommandId.make("concurrent-ordinary-0"))(
            Effect.succeed({ sequence: 1_100 }),
          ),
        ).toEqual({ sequence: 1_100 });
        expect(
          yield* commandExecution.run(CommandId.make("concurrent-ordinary-1099"))(
            Effect.die("newest concurrent result evicted"),
          ),
        ).toEqual({ sequence: 1_099 });
      }),
    ),
  );

  it.effect("interrupts an in-flight command when the execution scope closes", () =>
    Effect.gen(function* () {
      const outerScope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const commandExecution = yield* make.pipe(Effect.provideService(Scope.Scope, outerScope));
      yield* commandExecution
        .run(CommandId.make("command-shutdown"), { fingerprint: "shutdown-payload" })(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);

      yield* Scope.close(outerScope, Exit.void);
      yield* Deferred.await(interrupted);
    }),
  );
});

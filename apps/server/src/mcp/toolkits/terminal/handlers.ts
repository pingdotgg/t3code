import { randomUUID } from "node:crypto";

import type { TerminalSessionSnapshot, TerminalSummary } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Deferred, Effect, Exit, Option } from "effect";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Services/Manager.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TerminalToolkit, TerminalToolError } from "./tools.ts";

const toolError = (cause: { readonly message: string }) =>
  new TerminalToolError({ message: cause.message });

const requireTerminalAccess = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("terminal")) {
    return yield* new TerminalToolError({
      message: "Managed terminals are not available for this provider session.",
    });
  }
  return invocation;
});

const readTerminal = Effect.fn("TerminalToolkit.read")(function* (terminalId: string) {
  const { threadId } = yield* requireTerminalAccess;
  const terminals = yield* TerminalManager;
  const result = yield* Deferred.make<TerminalSessionSnapshot>();
  return yield* Effect.acquireUseRelease(
    terminals.attachStream({ threadId, terminalId }, (event) =>
      event.type === "snapshot"
        ? Deferred.succeed(result, {
            ...event.snapshot,
            history: event.snapshot.history.slice(-16_384),
          }).pipe(Effect.asVoid)
        : Effect.void,
    ),
    () => Deferred.await(result),
    (unsubscribe) => Effect.sync(unsubscribe),
  ).pipe(Effect.mapError(toolError));
});

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer({
  terminal_start: (input) =>
    Effect.gen(function* () {
      const { threadId } = yield* requireTerminalAccess;
      const projections = yield* ProjectionSnapshotQuery;
      const context = yield* projections
        .getThreadCheckpointContext(threadId)
        .pipe(Effect.mapError(toolError));
      if (Option.isNone(context)) {
        return yield* new TerminalToolError({ message: "The calling chat no longer exists." });
      }
      if (!input.command.trim()) {
        return yield* new TerminalToolError({ message: "A non-empty command is required." });
      }
      const terminals = yield* TerminalManager;
      const terminalId = `agent-${randomUUID()}`;
      const target = { threadId, terminalId };
      return yield* Effect.gen(function* () {
        yield* terminals.open(
          {
            ...target,
            cwd: context.value.worktreePath ?? context.value.workspaceRoot,
            worktreePath: context.value.worktreePath,
            env: projectScriptRuntimeEnv({
              project: { cwd: context.value.workspaceRoot },
              worktreePath: context.value.worktreePath,
            }),
          },
          { command: input.command },
        );
        return yield* readTerminal(terminalId);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? terminals.close(target).pipe(Effect.ignoreCause({ log: true }))
            : Effect.void,
        ),
        Effect.mapError(toolError),
      );
    }),
  terminal_list: () =>
    Effect.gen(function* () {
      const { threadId } = yield* requireTerminalAccess;
      const terminals = yield* TerminalManager;
      const result = yield* Deferred.make<{ readonly terminals: ReadonlyArray<TerminalSummary> }>();
      return yield* Effect.acquireUseRelease(
        terminals.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Deferred.succeed(result, {
                terminals: event.terminals.filter(
                  (terminal) =>
                    terminal.threadId === threadId && terminal.terminalId.startsWith("agent-"),
                ),
              }).pipe(Effect.asVoid)
            : Effect.void,
        ),
        () => Deferred.await(result),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
    }),
  terminal_read: ({ terminalId }) => readTerminal(terminalId),
  terminal_stop: ({ terminalId }) =>
    Effect.gen(function* () {
      const { threadId } = yield* requireTerminalAccess;
      const terminals = yield* TerminalManager;
      yield* readTerminal(terminalId);
      yield* terminals.close({ threadId, terminalId }).pipe(Effect.mapError(toolError));
      return { terminalId, closed: true };
    }),
});

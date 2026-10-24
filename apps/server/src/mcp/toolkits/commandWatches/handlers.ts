import {
  CommandId,
  OrchestratorMcpFailure,
  THREAD_COMMAND_WATCH_ID_PREFIX,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, loadCaller } from "../../threadAccess.ts";
import {
  CommandWatchFailedError,
  CommandWatchesToolkit,
  type UnwatchCommandInput,
  type WatchCommandInput,
} from "./tools.ts";

const DEFAULT_EVERY_MINUTES = 10;
const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);

/** What the orchestrator said when it refused, so the agent learns why. Anything else is logged. */
const refusal = <E>(cause: Cause.Cause<E>): Effect.Effect<never, CommandWatchFailedError> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
  const reason = Option.flatMap(Cause.findErrorOption(cause), (error) =>
    isDispatchError(error) && typeof error.cause === "string"
      ? Option.some(error.cause)
      : Option.none(),
  );
  return Option.match(reason, {
    onSome: (text) => Effect.fail(new CommandWatchFailedError({ reason: text })),
    onNone: () =>
      Effect.logWarning("command watch dispatch failed", { cause }).pipe(
        Effect.andThen(
          Effect.fail(
            new CommandWatchFailedError({ reason: "Could not change the command watch." }),
          ),
        ),
      ),
  });
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  const requireOrchestration = McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) =>
      scope.capabilities.has("orchestration")
        ? Effect.void
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "This credential cannot control threads.",
            }),
          ),
    ),
  );

  const watchesOf = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread.commandWatches ?? []),
      Effect.mapError(
        () => new CommandWatchFailedError({ reason: "Could not read this thread's watches." }),
      ),
    );

  return {
    watch_command: McpToolAccess.actsAsCaller((input: WatchCommandInput) =>
      Effect.gen(function* () {
        yield* requireOrchestration;
        const context = yield* loadCaller();
        const caller = context.caller;
        if (caller === undefined || caller.activeRunId === null) {
          return yield* new OrchestratorMcpFailure({
            code: "parent_not_active",
            message: "Only an agent running inside a T3 thread can watch a command.",
          });
        }
        yield* assertFullAccess(
          context,
          "Watching a command needs this thread in Full access, because T3 Code runs it later without asking. Ask the user to switch the thread to Full access, or check yourself instead.",
        );
        if (caller.lineage.relationshipToParent === "subagent") {
          return yield* new CommandWatchFailedError({
            reason:
              "This thread is a subagent, so it cannot watch commands. Finish your task and report back: the parent thread can watch.",
          });
        }
        const watchId = `${THREAD_COMMAND_WATCH_ID_PREFIX}${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
        yield* engine
          .dispatch({
            type: "thread.command-watch.start",
            commandId: CommandId.make(`server:mcp-command-watch:${caller.id}:${watchId}`),
            threadId: caller.id,
            callerRunId: caller.activeRunId,
            watchId,
            command: input.command,
            label: input.label,
            everyMinutes: input.everyMinutes ?? DEFAULT_EVERY_MINUTES,
          })
          .pipe(Effect.catchCause(refusal));
        const watches = yield* watchesOf(caller.id);
        // A repeated command keeps the watch it already had.
        const started = watches.find((watch) => watch.command === input.command);
        return {
          ...(started === undefined ? {} : { watchId: started.id }),
          watches,
        };
      }),
    ),
    unwatch_command: McpToolAccess.actsAsCaller((input: UnwatchCommandInput) =>
      Effect.gen(function* () {
        yield* requireOrchestration;
        const { caller } = yield* loadCaller();
        if (caller === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "parent_not_active",
            message: "Only an agent running inside a T3 thread can stop its command watches.",
          });
        }
        const commandSuffix = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        yield* engine
          .dispatch({
            type: "thread.command-watch.stop",
            commandId: CommandId.make(`server:mcp-command-unwatch:${caller.id}:${commandSuffix}`),
            threadId: caller.id,
            ...(input.watchId === undefined ? {} : { watchId: input.watchId }),
          })
          .pipe(Effect.catchCause(refusal));
        return { watches: yield* watchesOf(caller.id) };
      }),
    ),
  };
});

export const layer = McpToolAccess.toLayer(CommandWatchesToolkit, make);

import {
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ThreadId,
  type ThreadTurnStartBootstrap,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBootstrap from "../../../orchestration/Services/ThreadBootstrap.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ThreadStartCallerArchivedError,
  ThreadStartCallerNotFoundError,
  ThreadStartFailedError,
  type ThreadStartInput,
  ThreadStartProjectNotFoundError,
  type ThreadStartResult,
  ThreadStartWorktreeBaseRequiredError,
  ThreadsToolkit,
} from "./tools.ts";

const TITLE_MAX_CHARS = 80;

export function defaultThreadTitle(prompt: string): string {
  const firstLine =
    prompt
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? prompt;
  return firstLine.length <= TITLE_MAX_CHARS
    ? firstLine
    : `${firstLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

export function handoffMessageText(
  caller: Pick<OrchestrationThreadShell, "id" | "title">,
  prompt: string,
): string {
  return `> Handed off from T3 thread "${caller.title}" (${caller.id}).\n\n${prompt}`;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const uuidFromHex = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const bootstrap = yield* ThreadBootstrap.ThreadBootstrap;
  const crypto = yield* Crypto.Crypto;

  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const randomHex = (byteLength: number) =>
    crypto.randomBytes(byteLength).pipe(Effect.map(bytesToHex), Effect.orDie);
  const deterministicUUID = (seed: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(seed))
      .pipe(Effect.map(bytesToHex), Effect.map(uuidFromHex), Effect.orDie);

  const readThread = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.mapError((cause) => new ThreadStartFailedError({ cause })));

  const resultOf = (
    thread: Pick<
      OrchestrationThreadShell,
      | "id"
      | "title"
      | "modelSelection"
      | "runtimeMode"
      | "interactionMode"
      | "branch"
      | "worktreePath"
    >,
    alreadyStarted: boolean,
  ): ThreadStartResult => ({
    threadId: thread.id,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    alreadyStarted,
  });

  const worktreeBootstrap = Effect.fn("ThreadsToolkit.worktreeBootstrap")(function* (
    input: NonNullable<ThreadStartInput["worktree"]>,
    caller: OrchestrationThreadShell,
    project: OrchestrationProjectShell,
  ) {
    const baseBranch = input.baseBranch ?? caller.branch;
    if (baseBranch === null) {
      return yield* new ThreadStartWorktreeBaseRequiredError({});
    }
    const hex = yield* randomHex(4);
    const branch = input.branch ?? buildTemporaryWorktreeBranchName(() => hex);
    return {
      projectCwd: project.workspaceRoot,
      baseBranch,
      branch,
      ...(input.startFromOrigin === true ? { startFromOrigin: true } : {}),
    } satisfies NonNullable<ThreadTurnStartBootstrap["prepareWorktree"]>;
  });

  const start = Effect.fn("ThreadsToolkit.t3_thread_start")(function* (input: ThreadStartInput) {
    const scope = yield* McpInvocationContext.requireMcpCapability("threads");
    const caller = yield* readThread(scope.threadId);
    if (Option.isNone(caller)) {
      return yield* new ThreadStartCallerNotFoundError({ threadId: scope.threadId });
    }
    if (caller.value.archivedAt !== null) {
      return yield* new ThreadStartCallerArchivedError({ threadId: scope.threadId });
    }
    const project = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError((cause) => new ThreadStartFailedError({ cause })));
    if (Option.isNone(project)) {
      return yield* new ThreadStartProjectNotFoundError({ projectId: caller.value.projectId });
    }

    const requestKey = input.clientRequestId;
    const threadId = ThreadId.make(
      requestKey === undefined
        ? yield* randomUUID
        : yield* deterministicUUID(`${scope.threadId}\n${requestKey}`),
    );
    if (requestKey !== undefined) {
      const existing = yield* readThread(threadId);
      if (Option.isSome(existing)) {
        return resultOf(existing.value, true);
      }
    }
    const commandId = CommandId.make(
      `server:mcp-thread-start:${scope.threadId}:${requestKey ?? (yield* randomUUID)}`,
    );
    const messageId = MessageId.make(yield* randomUUID);

    const modelSelection = input.modelSelection ?? caller.value.modelSelection;
    const interactionMode = input.interactionMode ?? caller.value.interactionMode;
    const runtimeMode = caller.value.runtimeMode;
    const titleSeed = defaultThreadTitle(input.prompt);
    const title = input.title ?? titleSeed;
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    const prepareWorktree = input.worktree
      ? yield* worktreeBootstrap(input.worktree, caller.value, project.value)
      : undefined;
    const createThread = {
      projectId: caller.value.projectId,
      title,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: prepareWorktree ? null : caller.value.branch,
      worktreePath: prepareWorktree ? null : caller.value.worktreePath,
      createdAt,
    };

    const alreadyStarted = yield* bootstrap
      .dispatchTurnStart({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: handoffMessageText(caller.value, input.prompt),
          attachments: [],
        },
        modelSelection,
        ...(input.title === undefined ? { titleSeed } : {}),
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread,
          ...(prepareWorktree ? { prepareWorktree, runSetupScript: true } : {}),
        },
        createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(new ThreadStartFailedError({ cause })),
        ),
        Effect.as(false),
        requestKey === undefined
          ? (effect) => effect
          : Effect.catchTag("ThreadStartFailedError", (error) =>
              readThread(threadId).pipe(
                Effect.flatMap((thread) =>
                  Option.isSome(thread) ? Effect.succeed(true) : Effect.fail(error),
                ),
              ),
            ),
      );

    const started = yield* readThread(threadId);
    return Option.isSome(started)
      ? resultOf(started.value, alreadyStarted)
      : resultOf({ id: threadId, ...createThread }, false);
  });

  return ThreadsToolkit.of({ t3_thread_start: start });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);

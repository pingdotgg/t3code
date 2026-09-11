import { CommandId, MessageId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolError, ThreadsToolkit } from "./tools.ts";

const summary = (thread: OrchestrationThreadShell, attentionIds: ReadonlyArray<string> = []) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  settledAt: thread.settledAt,
  settledOverride: thread.settledOverride,
  session: thread.session,
  latestTurn: thread.latestTurn,
  latestUserMessageAt: thread.latestUserMessageAt,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  backgroundLiveness: thread.backgroundLiveness,
  // Exclude commentary and timestamps: they must not repeat a completion notification.
  cursor: JSON.stringify([
    thread.latestTurn?.turnId ?? null,
    thread.latestTurn?.state ?? null,
    thread.session?.status ?? null,
    thread.hasPendingApprovals,
    thread.hasPendingUserInput,
    thread.settledAt,
    thread.backgroundLiveness ?? null,
    attentionIds,
  ]),
});

const needsAttention = (thread: ReturnType<typeof summary>) =>
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput ||
  (thread.session?.status === "error" &&
    (thread.latestUserMessageAt === null ||
      thread.session.updatedAt >= thread.latestUserMessageAt)) ||
  ((thread.latestUserMessageAt === null ||
    [
      thread.latestTurn?.requestedAt,
      thread.latestTurn?.startedAt,
      thread.latestTurn?.completedAt,
    ].some((at) => at != null && at >= thread.latestUserMessageAt!)) &&
    thread.session?.status !== "starting" &&
    thread.session?.status !== "running" &&
    thread.backgroundLiveness !== "working" &&
    thread.latestTurn !== null &&
    thread.latestTurn.state !== "running");

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (caller: OrchestrationThreadShell, id?: CommandId) =>
    id === undefined
      ? uuid.pipe(Effect.map(CommandId.make))
      : Effect.succeed(CommandId.make(`mcp:${caller.id}:${id}`));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const failed = () => new ThreadToolError({ message: "Thread operation failed." });
  const load = Effect.fn("ThreadsToolkit.load")(function* (threadId: ThreadId) {
    const thread = yield* snapshots.getThreadShellById(threadId).pipe(Effect.mapError(failed));
    if (Option.isNone(thread) || thread.value.archivedAt !== null) {
      return yield* new ThreadToolError({ message: "Thread is unavailable in this project." });
    }
    return thread.value;
  });
  const source = Effect.fn("ThreadsToolkit.source")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("threads");
    return yield* load(scope.threadId);
  });
  const target = Effect.fn("ThreadsToolkit.target")(function* (
    threadId: ThreadId,
    caller: OrchestrationThreadShell,
  ) {
    const thread = yield* load(threadId);
    if (thread.projectId !== caller.projectId) {
      return yield* new ThreadToolError({ message: "Thread is unavailable in this project." });
    }
    return thread;
  });
  const summarize = Effect.fn("ThreadsToolkit.summarize")(function* (
    thread: OrchestrationThreadShell,
  ) {
    if (!thread.hasPendingApprovals && !thread.hasPendingUserInput) return summary(thread);
    const detail = yield* snapshots
      .getThreadDetailSnapshot(thread.id, { turnLimit: 1 })
      .pipe(Effect.mapError(failed));
    if (Option.isNone(detail)) return yield* failed();
    const attentionIds = detail.value.thread.activities
      .filter(
        (activity) =>
          activity.kind === "approval.requested" || activity.kind === "user-input.requested",
      )
      .map((activity) => activity.id)
      .sort();
    return summary(thread, attentionIds);
  });
  const dispatch = Effect.fn("ThreadsToolkit.dispatch")(function* (
    command: Extract<Parameters<typeof engine.dispatch>[0], { readonly threadId: ThreadId }>,
  ) {
    const receipt = yield* engine.dispatch(command).pipe(Effect.mapError(failed));
    return { threadId: command.threadId, ...receipt };
  });

  return ThreadsToolkit.of({
    create_thread: (input) =>
      Effect.gen(function* () {
        const caller = yield* source();
        const id = yield* commandId(caller, input.commandId);
        return yield* dispatch({
          type: "thread.create",
          commandId: id,
          threadId: ThreadId.make(`mcp-thread:${id}`),
          projectId: caller.projectId,
          title: input.title,
          modelSelection: input.modelSelection ?? caller.modelSelection,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: yield* now,
        });
      }),
    list_threads: (input) =>
      Effect.gen(function* () {
        const caller = yield* source();
        const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(failed));
        const threads = snapshot.threads
          .filter(
            (thread) =>
              thread.projectId === caller.projectId &&
              thread.archivedAt === null &&
              (input.beforeThreadId === undefined || thread.id < input.beforeThreadId),
          )
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const page = threads.slice(0, input.limit ?? 20);
        return {
          threads: yield* Effect.forEach(page, summarize),
          nextBeforeThreadId: threads.length > page.length ? page.at(-1)!.id : null,
        };
      }),
    read_thread: (input) =>
      Effect.gen(function* () {
        const caller = yield* source();
        const thread = yield* target(input.threadId, caller);
        const detail = yield* snapshots
          .getThreadDetailSnapshot(thread.id, {
            turnLimit: input.turnLimit ?? 10,
            ...(input.beforeCursor === undefined ? {} : { beforeCursor: input.beforeCursor }),
          })
          .pipe(Effect.mapError(failed));
        if (Option.isNone(detail)) return yield* failed();
        return {
          thread: yield* summarize(thread),
          snapshotSequence: detail.value.snapshotSequence,
          ...(detail.value.page === undefined ? {} : { page: detail.value.page }),
          messages: detail.value.thread.messages.map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text.slice(0, 8000),
            truncated: message.text.length > 8000,
            createdAt: message.createdAt,
          })),
        };
      }),
    send_message_to_thread: (input) =>
      Effect.gen(function* () {
        const caller = yield* source();
        const thread = yield* target(input.threadId, caller);
        const id = yield* commandId(caller, input.commandId);
        return yield* dispatch({
          type: "thread.turn.start",
          commandId: id,
          threadId: thread.id,
          message: {
            messageId: MessageId.make(`mcp-message:${id}`),
            role: "user",
            attachments: [],
            text: `Message from T3 thread ${caller.id}.${input.replyToSource === false ? "" : " Reply with send_message_to_thread using that thread ID."}\n\n${input.message}`,
          },
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: yield* now,
        });
      }),
    wait_threads: (input) =>
      Effect.gen(function* () {
        const caller = yield* source();
        const read = Effect.forEach(input.targets, (entry) =>
          target(entry.threadId, caller).pipe(Effect.flatMap(summarize)),
        );
        const ready = (threads: ReadonlyArray<ReturnType<typeof summary>>) =>
          threads.some(
            (thread, index) =>
              needsAttention(thread) && thread.cursor !== input.targets[index]?.cursor,
          );
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // Subscribe before reading so a completion between the read and wait is not lost.
            const events = yield* engine.subscribeDomainEvents;
            const initial = yield* read;
            if (ready(initial)) return { threads: initial, timedOut: false };
            const result = yield* events.pipe(
              Stream.filter((event) =>
                input.targets.some((entry) => entry.threadId === event.aggregateId),
              ),
              Stream.mapEffect(() => read),
              Stream.filter(ready),
              Stream.runHead,
              Effect.timeoutOption((input.timeoutSeconds ?? 60) * 1000),
            );
            const completed = Option.flatMap(result, (value) => value);
            return Option.isSome(completed)
              ? { threads: completed.value, timedOut: false }
              : { threads: yield* read, timedOut: true };
          }),
        );
      }),
    set_thread_settled: (input) =>
      Effect.gen(function* () {
        const caller = yield* source();
        const thread = yield* target(input.threadId, caller);
        const id = yield* commandId(caller, input.commandId);
        return yield* dispatch(
          input.settled
            ? { type: "thread.settle", commandId: id, threadId: thread.id }
            : { type: "thread.unsettle", commandId: id, threadId: thread.id, reason: "user" },
        );
      }),
    interrupt_thread: (input) =>
      Effect.gen(function* () {
        const caller = yield* source();
        const thread = yield* target(input.threadId, caller);
        return yield* dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* commandId(caller, input.commandId),
          threadId: thread.id,
          createdAt: yield* now,
        });
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);

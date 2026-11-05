import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type RunId,
  SIDE_CHAT_WAIT_CAP_MS,
  TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../../serverSettings.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import type * as ProjectStore from "../ProjectStore.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import {
  buildSideChatOutcomeInput,
  isUserAuthoredSideChatTrigger,
  nestedSideChatNoteLines,
  nestedSideChatNotesFallback,
  normalizeSideChatNote,
} from "./notes.ts";
import {
  readySideChatNotes,
  sideChatChildren,
  sideChatLessonThreadId,
  undeliveredGeneratingSideChats,
  undeliveredReadySideChatNotes,
} from "./tree.ts";
import { makeWriteSideChatText } from "./writeSideChatText.ts";

type SideChatCascadeAction = "archive" | "unarchive" | "delete";

export class SideChatLifecycleService extends Context.Service<
  SideChatLifecycleService,
  {
    /**
     * Lands the note for the `generating` outcome `requestId`, taking up nested side chats' notes
     * (waiting until `SIDE_CHAT_WAIT_CAP_MS` after Done); a null answer becomes those notes until
     * the lesson holds one of this side chat's. Never fails: errors are recorded as `failed`,
     * because a failed outbox row pins the lesson's worktree.
     */
    readonly writeOutcome: (input: {
      readonly threadId: ThreadId;
      readonly requestId: string;
    }) => Effect.Effect<void>;
    /**
     * Before a turn whose message is the user's own, waits for side-chat notes still being written
     * (until `SIDE_CHAT_WAIT_CAP_MS` after the send), then attaches the ready ones it has not
     * received. Never fails: errors are logged and the turn starts without the notes.
     */
    readonly awaitNotesForRunStart: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
    /**
     * Archives, unarchives or deletes the side chats directly below the thread, as the thread's
     * own `commandId` did to it. Each one's own command does the same to the side chats below it.
     * Fails after trying every child if one could not follow, so the outbox retries; a refused
     * command only logs, since its refusal replays. Children already moved are skipped on retry.
     */
    readonly cascade: (input: {
      readonly threadId: ThreadId;
      readonly action: SideChatCascadeAction;
      readonly commandId: CommandId;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/sideChat/SideChatLifecycleService") {}

const SIDE_CHAT_CASCADE_COMMAND_TYPES = {
  archive: "thread.archive",
  unarchive: "thread.unarchive",
  delete: "thread.delete",
} as const;

/** Whether `action` has nothing left to do to `thread`. */
const isInCascadeTargetState = (
  thread: OrchestrationV2AppThread,
  action: SideChatCascadeAction,
): boolean => {
  switch (action) {
    case "archive":
      return thread.archivedAt !== null;
    case "unarchive":
      return thread.archivedAt === null;
    case "delete":
      return thread.deletedAt !== null;
  }
};

/**
 * The nested side chats whose notes a written note took up the chain, by the note's request, and
 * the nested note lines it was written with.
 */
interface ChildNoteDeliveries {
  readonly childNoteDeliveries?: Readonly<Record<ThreadId, string>>;
  readonly nestedNotes?: ReadonlyArray<string>;
}

type OutcomeResult =
  | ({ readonly status: "ready"; readonly note: string } & ChildNoteDeliveries)
  | ({ readonly status: "none"; readonly note: null } & ChildNoteDeliveries)
  | { readonly status: "failed"; readonly note: null; readonly error: string };

type TranscriptMessage = OrchestrationV2ConversationMessage & {
  readonly role: "user" | "assistant";
};

const isTextGenerationError = Schema.is(TextGenerationError);

/** Whether `event` ends a wait for a side chat's note: it was deleted, or stopped generating. */
const settlesSideChatNote = (event: OrchestrationV2DomainEvent): boolean =>
  event.type === "thread.deleted" ||
  (event.type === "thread.metadata-updated" &&
    event.payload.sideChat?.done?.outcome.status !== "generating");

/** The text generation's own explanation when it failed, otherwise a generic one. */
const failureDetail = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "Couldn't write the note.",
    onSome: (error) => (isTextGenerationError(error) ? error.detail : "Couldn't write the note."),
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const writeSideChatText = yield* makeWriteSideChatText;

  /**
   * Waits until every side chat in `threadIds` is deleted or its note stops generating, reading
   * their events after `afterSequence`, but not past `deadline`. A failed read ends the wait.
   */
  const awaitSideChatNotes = Effect.fn("SideChatLifecycleService.awaitSideChatNotes")(
    function* (threadIds: ReadonlyArray<ThreadId>, afterSequence: number, deadline: DateTime.Utc) {
      const remainingMillis =
        DateTime.toEpochMillis(deadline) - DateTime.toEpochMillis(yield* DateTime.now);
      if (threadIds.length === 0 || remainingMillis <= 0) return;
      yield* Effect.forEach(
        threadIds,
        (threadId) =>
          eventSink.stream({ threadId, afterSequence }).pipe(
            Stream.filter((stored) => settlesSideChatNote(stored.event)),
            Stream.runHead,
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.timeoutOption(remainingMillis));
    },
    (effect, threadIds) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Side-chat notes wait failed", { threadIds, error }),
        ),
      ),
  );

  const awaitNotesForRunStart: SideChatLifecycleService["Service"]["awaitNotesForRunStart"] =
    Effect.fn("SideChatLifecycleService.awaitNotesForRunStart")(
      function* (input) {
        // Every provider turn passes through here, so the cheap checks come first.
        const { thread, runs, messages } = yield* projections.getThreadRecords(
          input.threadId,
          ["runs", "messages"],
          { runIds: [input.runId], messageRunIds: [input.runId], messageRoles: ["user"] },
        );
        const run = runs.find((candidate) => candidate.id === input.runId);
        const message = messages.find((candidate) => candidate.id === run?.userMessageId);
        if (
          run?.status !== "starting" ||
          message === undefined ||
          !isUserAuthoredSideChatTrigger(message)
        ) {
          return;
        }
        if (
          !(yield* projections.hasSideChatChildren({
            projectId: thread.projectId,
            parentThreadId: thread.id,
          }))
        ) {
          return;
        }
        // Read before the children, so a note that settles after the read is still seen.
        const afterSequence = yield* eventSink.latestSequence();
        const children = sideChatChildren(
          yield* projections.getSideChatThreads({
            projectId: thread.projectId,
            lessonThreadId: sideChatLessonThreadId(thread),
          }),
          thread.id,
        );
        const generating = undeliveredGeneratingSideChats(thread, children);
        if (
          generating.length === 0 &&
          undeliveredReadySideChatNotes(thread, children).length === 0
        ) {
          return;
        }
        // The cap counts from the send, so a queued message does not wait again when it starts.
        yield* awaitSideChatNotes(
          generating,
          afterSequence,
          DateTime.add(run.requestedAt, { milliseconds: SIDE_CHAT_WAIT_CAP_MS }),
        );
        yield* threads.dispatch({
          type: "thread.side_chat.notes.attach",
          commandId: CommandId.make(`${input.runId}:side-chat-notes`),
          threadId: input.threadId,
          runId: input.runId,
        });
      },
      (effect, input) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Side-chat notes could not be attached", {
                  threadId: input.threadId,
                  runId: input.runId,
                  cause,
                }),
          ),
        ),
    );

  const writeOutcome: SideChatLifecycleService["Service"]["writeOutcome"] = Effect.fn(
    "SideChatLifecycleService.writeOutcome",
  )(function* (input) {
    const result: OutcomeResult | "stale" = yield* Effect.gen(function* () {
      // Read before the nested side chats, so a note of theirs that settles after the read is
      // still seen.
      const afterSequence = yield* eventSink.latestSequence();
      const records = yield* threads.getThreadRecords(
        input.threadId,
        ["messages", "contextHandoffs", "runs"],
        { messageRoles: ["user", "assistant"] },
      );
      const { thread } = records;
      const sideChat = thread.sideChat;
      const done = sideChat?.done;
      if (
        sideChat === undefined ||
        done == null ||
        thread.deletedAt !== null ||
        done.outcome.status !== "generating" ||
        done.outcome.requestId !== input.requestId
      ) {
        return "stale" as const;
      }

      const readChildren = projections
        .getSideChatThreads({
          projectId: thread.projectId,
          lessonThreadId: sideChat.lessonThreadId,
        })
        .pipe(Effect.map((sideChats) => sideChatChildren(sideChats, thread.id)));
      let children = yield* readChildren;
      const generating = undeliveredGeneratingSideChats(thread, children);
      if (generating.length > 0) {
        // The cap counts from Done, which started the nested side chats' notes too.
        yield* awaitSideChatNotes(
          generating,
          afterSequence,
          DateTime.add(DateTime.makeUnsafe(done.at), { milliseconds: SIDE_CHAT_WAIT_CAP_MS }),
        );
        children = yield* readChildren;
      }
      // Every ready note, not only undelivered ones: one an earlier Done took up went no further
      // if this side chat reopened before its parent received that note. Only the lesson's
      // receipt is final, and a reopen keeps what it received as `deliveredNestedNotes`.
      const childNotes = readySideChatNotes(children);
      const nestedNotes = {
        childNotes,
        contextHandoffs: records.contextHandoffs,
        delivered: sideChat.deliveredNestedNotes ?? [],
      };
      const nestedNoteLines = [...nestedSideChatNoteLines(nestedNotes)];
      const previousNote = sideChat.deliveredNote ?? null;
      const cancelledBeforeStart = new Set(
        records.runs
          .filter((run) => run.status === "cancelled" && run.startedAt === null)
          .map((run) => run.id),
      );

      const lesson = yield* threads.getThreadRecords(sideChat.lessonThreadId, []);
      const { text } = yield* writeSideChatText({
        thread: lesson.thread,
        kind: "outcome_note",
        prompt: buildSideChatOutcomeInput({
          ...nestedNotes,
          excerpt: sideChat.excerpt,
          messages: records.messages
            .filter(
              (message): message is TranscriptMessage =>
                message.role !== "system" &&
                !(message.runId !== null && cancelledBeforeStart.has(message.runId)),
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
            ),
          previousNote,
        }),
      });
      // Once the lesson holds a note of this side chat, null means nothing new, and a fallback
      // would send again what that note already carried.
      const note =
        normalizeSideChatNote(text) ??
        (previousNote === null ? nestedSideChatNotesFallback(nestedNotes) : null);
      const deliveries = {
        ...(childNotes.length === 0
          ? {}
          : {
              childNoteDeliveries: Object.fromEntries(
                childNotes.map((childNote) => [childNote.threadId, childNote.requestId]),
              ),
            }),
        ...(nestedNoteLines.length === 0 ? {} : { nestedNotes: nestedNoteLines }),
      };
      return (
        note === null
          ? { status: "none", note: null, ...deliveries }
          : { status: "ready", note, ...deliveries }
      ) satisfies OutcomeResult;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Side chat note failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(
              Effect.as({
                status: "failed",
                note: null,
                error: failureDetail(cause),
              } satisfies OutcomeResult),
            ),
      ),
    );
    if (result === "stale") {
      return;
    }

    yield* threads
      .dispatch({
        type: "thread.side_chat.outcome.complete",
        commandId: CommandId.make(`${input.requestId}:outcome-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...result,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Side chat note could not be recorded", {
                threadId: input.threadId,
                requestId: input.requestId,
                status: result.status,
                cause,
              }),
        ),
      );
  });

  const REFUSED_COMMAND_TAGS = new Set([
    "OrchestratorCommandRejectedError",
    "OrchestratorCommandPreviouslyRejectedError",
  ]);

  const cascade: SideChatLifecycleService["Service"]["cascade"] = Effect.fn(
    "SideChatLifecycleService.cascade",
  )(function* (input) {
    // A deleted thread still reads, so a delete reaches the side chats below it.
    const thread = yield* projections.getThread(input.threadId);
    const children = sideChatChildren(
      yield* projections.getSideChatThreads({
        projectId: thread.projectId,
        lessonThreadId: sideChatLessonThreadId(thread),
      }),
      thread.id,
    ).filter((child) => !isInCascadeTargetState(child, input.action));
    const failures = yield* Effect.forEach(
      children,
      (child) => {
        const command = {
          type: SIDE_CHAT_CASCADE_COMMAND_TYPES[input.action],
          commandId: CommandId.make(`${input.commandId}:side-chat-cascade:${child.id}`),
          threadId: child.id,
        } as const;
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(threads.dispatch(command));
          if (Exit.isSuccess(exit)) return Option.none<string>();
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
          yield* Effect.logWarning("Side chat could not follow its parent", {
            parentThreadId: input.threadId,
            threadId: child.id,
            action: input.action,
            cause: exit.cause,
          });
          // A refusal replays for the same command id, so retrying it cannot help.
          const refused = Option.exists(Cause.findErrorOption(exit.cause), (error) =>
            REFUSED_COMMAND_TAGS.has(error._tag),
          );
          return refused ? Option.none<string>() : Option.some(Cause.pretty(exit.cause));
        });
      },
      { discard: false },
    );
    const firstFailure = failures.find(Option.isSome);
    if (firstFailure !== undefined) {
      return yield* Effect.die(firstFailure.value);
    }
  }, Effect.orDie);

  return SideChatLifecycleService.of({ writeOutcome, awaitNotesForRunStart, cascade });
});

export const layer: Layer.Layer<
  SideChatLifecycleService,
  never,
  | ThreadManagementService.ThreadManagementService
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | EventSink.EventSinkV2
  | ServerSettings.ServerSettingsService
  | ProviderRegistry.ProviderRegistry
  | TextGeneration.TextGeneration
  | FileSystem.FileSystem
> = Layer.effect(SideChatLifecycleService, make);

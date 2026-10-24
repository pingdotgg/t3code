import {
  CommandId,
  MessageId,
  OrchestrationV2WriteForkNoteError,
  type OrchestrationV2WriteForkNoteInput,
  type OrchestrationV2WriteForkNoteResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { isForkableSourceRunStatus } from "./ThreadForkService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const NOTE_TIMEOUT_MS = 5 * 60_000;

function forkNotePrompt(targetLabel: string): string {
  return [
    `This conversation is being forked to another machine, "${targetLabel}". A new agent there continues the work with none of this context, a fresh checkout of the pushed branch, and different absolute paths. Uncommitted changes here do not go with it.`,
    "",
    "Write the handoff note that agent needs. Do not run tools or change files. Reply with only the note, in Markdown, under these headings:",
    "",
    "- Goal: what we are doing and what done means.",
    "- Decisions: what we decided and why, including approaches we rejected.",
    "- Current state: what works, what does not, and what is not committed.",
    "- Next steps: in order.",
    "- Files: the files and key symbols that matter, with paths relative to the repository root.",
    "- Verify: the commands that check the work.",
    "- Gotchas: anything surprising we found.",
    "",
    "Be specific and dense. Leave out anything the next agent can read from the code.",
  ].join("\n");
}

/**
 * Writes a handoff note for forking a thread to another environment. The note
 * comes from a scratch native fork of the thread, so the agent writing it sees
 * the full provider context (tool output, files read), not a text summary, and
 * the source thread gains no turn. The scratch fork is deleted afterwards,
 * including on failure or interruption.
 */
export class ThreadForkNoteService extends Context.Service<
  ThreadForkNoteService,
  {
    readonly write: (
      input: OrchestrationV2WriteForkNoteInput,
    ) => Effect.Effect<OrchestrationV2WriteForkNoteResult, OrchestrationV2WriteForkNoteError>;
  }
>()("t3/orchestration-v2/ThreadForkNoteService") {}

export const layer = Layer.effect(
  ThreadForkNoteService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const crypto = yield* Crypto.Crypto;

    const write = Effect.fn("ThreadForkNoteService.write")(function* (
      input: OrchestrationV2WriteForkNoteInput,
    ) {
      const fail = (message: string) => (cause: unknown) =>
        new OrchestrationV2WriteForkNoteError({ threadId: input.threadId, message, cause });
      const source = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(fail("Could not read the thread.")));
      if (source === null || source.deletedAt !== null) {
        return yield* new OrchestrationV2WriteForkNoteError({
          threadId: input.threadId,
          message: "The thread was not found.",
        });
      }
      // The latest turn, even a stopped or failed one, so the note covers it.
      const { runs } = yield* threads
        .getThreadRecords(source.id, ["runs"])
        .pipe(Effect.mapError(fail("Could not read the thread.")));
      const latestRun = runs
        .filter((run) => run.status !== "rolled_back")
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (latestRun === undefined || !isForkableSourceRunStatus(latestRun.status)) {
        return yield* new OrchestrationV2WriteForkNoteError({
          threadId: input.threadId,
          message:
            latestRun === undefined
              ? "This thread has no turn to fork yet."
              : "Wait for the current turn to finish.",
        });
      }
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const scratchThreadId = ThreadId.make(`fork-note:${id}`);

      const fork = threads
        .dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`fork-note:${id}:fork`),
          sourceThreadId: source.id,
          targetThreadId: scratchThreadId,
          sourcePoint: { type: "run", runId: latestRun.id },
          title: `Fork note: ${source.title}`,
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((error) =>
            fail(
              "cause" in error && typeof error.cause === "string"
                ? error.cause
                : "Could not fork the thread.",
            )(error),
          ),
        );
      const writeNote = Effect.gen(function* () {
        const sent = yield* threads
          .sendToThread({
            projectId: source.projectId,
            commandId: CommandId.make(`fork-note:${id}:send`),
            threadId: scratchThreadId,
            messageId: MessageId.make(`fork-note:${id}:prompt`),
            text: forkNotePrompt(input.targetLabel),
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(Effect.mapError(fail("Could not start the agent that writes the note.")));
        const waited = yield* threads
          .waitForThread({
            projectId: source.projectId,
            threadId: scratchThreadId,
            runId: sent.run.id,
            timeoutMs: NOTE_TIMEOUT_MS,
          })
          .pipe(Effect.mapError(fail("Could not follow the agent that writes the note.")));
        const run = waited.run;
        if (waited.timedOut || run === null) {
          return yield* new OrchestrationV2WriteForkNoteError({
            threadId: input.threadId,
            message: "The agent did not finish the note in time.",
          });
        }
        if (run.status !== "completed" && run.status !== "waiting") {
          return yield* new OrchestrationV2WriteForkNoteError({
            threadId: input.threadId,
            message: `The agent that writes the note ${run.status === "failed" ? "failed" : "stopped"}.`,
          });
        }
        const { messages } = yield* threads
          .getThreadRecords(scratchThreadId, ["messages"])
          .pipe(Effect.mapError(fail("Could not read the note.")));
        const note = messages
          .findLast((message) => message.role === "assistant" && message.runId === run.id)
          ?.text.trim();
        if (!note) {
          return yield* new OrchestrationV2WriteForkNoteError({
            threadId: input.threadId,
            message: "The agent finished without writing a note.",
          });
        }
        return { note };
      });

      const deleteScratch = threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`fork-note:${id}:delete`),
          threadId: scratchThreadId,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("fork note scratch thread was not deleted", {
              scratchThreadId,
              cause,
            }),
          ),
        );
      return yield* Effect.acquireUseRelease(
        fork,
        () => writeNote,
        () => deleteScratch,
      );
    });

    return ThreadForkNoteService.of({ write });
  }),
);

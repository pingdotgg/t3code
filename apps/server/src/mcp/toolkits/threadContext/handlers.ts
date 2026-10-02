import { Effect, Option } from "effect";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import {
  THREAD_READ_DEFAULT_LIMIT,
  THREAD_READ_MAX_CHARS_PER_MESSAGE,
  ThreadContextToolkit,
  ThreadContextToolError,
  type T3ThreadReadMessage,
} from "./tools.ts";

const toolError = (message: string) => new ThreadContextToolError({ message });

const truncateMessageText = (text: string): Pick<T3ThreadReadMessage, "text" | "truncated"> =>
  text.length > THREAD_READ_MAX_CHARS_PER_MESSAGE
    ? {
        text: `${text.slice(0, THREAD_READ_MAX_CHARS_PER_MESSAGE)}\n…[truncated]`,
        truncated: true,
      }
    : { text, truncated: false };

/**
 * Server-scoped, bounded, read-only thread-history reads for provider MCP
 * sessions. Authority comes from the authenticated invocation scope and ends
 * at this server's projection database: rows are selected with a SQL-side
 * cursor and row cap before anything is decoded, so large threads never
 * hydrate fully. Message text travels verbatim — nested `t3-context://`
 * references are never expanded, so one read cannot recursively pull in
 * another thread's history. Missing and deleted threads share one
 * `thread_not_found` outcome; the tool cannot distinguish them and must not
 * leak anything else.
 */
export const ThreadContextToolkitHandlersLive = ThreadContextToolkit.toLayer({
  t3_thread_read: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext;
      const cursorComplete =
        (input.afterCreatedAt === undefined) === (input.afterMessageId === undefined);
      if (!cursorComplete) {
        return yield* toolError(
          "Invalid history cursor: afterCreatedAt and afterMessageId must be passed together from nextCursor.",
        );
      }
      const projections = yield* ProjectionSnapshotQuery;
      const shell = yield* projections
        .getThreadShellById(input.threadId)
        .pipe(
          Effect.mapError((cause) =>
            toolError(`Could not resolve thread '${input.threadId}': ${String(cause)}.`),
          ),
        );
      if (Option.isNone(shell)) {
        return yield* toolError(`Thread '${input.threadId}' was not found or has been deleted.`);
      }
      const limit = input.limit ?? THREAD_READ_DEFAULT_LIMIT;
      const repository = yield* ProjectionThreadMessageRepository;
      const rows = yield* repository
        .listMessagesPage({
          threadId: input.threadId,
          ...(input.afterCreatedAt !== undefined && input.afterMessageId !== undefined
            ? { afterCreatedAt: input.afterCreatedAt, afterMessageId: input.afterMessageId }
            : {}),
          // Over-read by one to detect the next page without a second query.
          limit: limit + 1,
        })
        .pipe(
          Effect.mapError((cause) =>
            toolError(`Could not read thread '${input.threadId}' history: ${String(cause)}.`),
          ),
        );
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = page.at(-1);
      return {
        threadId: input.threadId,
        title: shell.value.title,
        messages: page.map(
          (row): T3ThreadReadMessage => ({
            messageId: row.messageId,
            role: row.role,
            ...truncateMessageText(row.text),
            turnId: row.turnId,
            createdAt: row.createdAt,
          }),
        ),
        nextCursor:
          hasMore && last !== undefined
            ? { afterCreatedAt: last.createdAt, afterMessageId: last.messageId }
            : null,
        hasMore,
      };
    }),
});

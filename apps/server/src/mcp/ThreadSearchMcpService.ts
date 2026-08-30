import {
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadSearchInput,
  type OrchestratorMcpThreadSearchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const DEFAULT_LIMIT = 20;
const DEFAULT_SNIPPET_CHARS = 240;

export class ThreadSearchMcpService extends Context.Service<
  ThreadSearchMcpService,
  {
    readonly search: (
      scope: McpInvocationScope,
      input: OrchestratorMcpThreadSearchInput,
    ) => Effect.Effect<OrchestratorMcpThreadSearchResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadSearchMcpService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService;
  const projectionQuery = yield* ProjectionSnapshotQuery;

  const loadShell = (threadId: McpInvocationScope["threadId"]) =>
    threadManagement.getThreadShell(threadId).pipe(
      Effect.mapError(() => failure("orchestration_error", `Unable to read thread ${threadId}.`)),
      Effect.flatMap((shell) =>
        shell === null
          ? Effect.fail(failure("thread_not_found", `Thread ${threadId} was not found.`))
          : Effect.succeed(shell),
      ),
    );

  return {
    search: (scope, input) =>
      Effect.gen(function* () {
        if (!scope.capabilities.has("orchestration")) {
          return yield* failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          );
        }

        const caller = yield* loadShell(scope.threadId);
        if (input.threadId !== undefined) {
          const target = yield* loadShell(input.threadId);
          if (target.projectId !== caller.projectId) {
            return yield* failure(
              "thread_not_found",
              `Thread ${input.threadId} was not found in this project.`,
            );
          }
        }

        const page = yield* projectionQuery
          .searchThreadContent({
            projectId: caller.projectId,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            query: input.query,
            includeArchived: input.includeArchived === true,
            offset: input.cursor ?? 0,
            limit: input.limit ?? DEFAULT_LIMIT,
            snippetChars: input.snippetChars ?? DEFAULT_SNIPPET_CHARS,
          })
          .pipe(
            Effect.catchTags({
              ProjectionThreadContentSearchInputError: (error) =>
                Effect.fail(failure("invalid_request", error.message)),
              PersistenceSqlError: () =>
                Effect.fail(
                  failure(
                    "orchestration_error",
                    `Unable to search thread content in project ${caller.projectId}.`,
                  ),
                ),
              PersistenceDecodeError: () =>
                Effect.fail(
                  failure(
                    "orchestration_error",
                    `Unable to search thread content in project ${caller.projectId}.`,
                  ),
                ),
            }),
          );

        return {
          projectId: caller.projectId,
          hits: page.hits.map((hit) => ({
            threadId: hit.threadId,
            projectId: hit.projectId,
            threadTitle: hit.threadTitle,
            threadTitleTruncated: hit.threadTitleTruncated,
            archived: hit.archived,
            source: hit.source,
            origin: hit.origin,
            snippet: hit.snippet,
            snippetTruncated: hit.snippetTruncated,
            matchedAt: hit.matchedAt,
            messageId: hit.messageId,
            runId: hit.runId,
            itemId: hit.itemId,
            readAnchor:
              hit.sourceThreadId === null || hit.messageId === null
                ? null
                : { sourceThreadId: hit.sourceThreadId, messageId: hit.messageId },
          })),
          nextCursor: page.nextOffset,
          hasMore: page.hasMore,
          traversalTruncated: page.hasMore && page.nextOffset === null,
          consistency: "live",
        } satisfies OrchestratorMcpThreadSearchResult;
      }),
  } satisfies ThreadSearchMcpService["Service"];
});

export const layer = Layer.effect(ThreadSearchMcpService, make);

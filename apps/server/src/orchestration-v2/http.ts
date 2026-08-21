import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import {
  buildBoundedThreadProjection,
  InvalidThreadHistoryCursorError,
  selectHistoryPageFromCursor,
} from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { buildActiveShellSnapshot } from "./ShellStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

function selectHistoryPageFromCursorOrError(
  input: Parameters<typeof selectHistoryPageFromCursor>[0],
):
  | { readonly _tag: "ok"; readonly page: ReturnType<typeof selectHistoryPageFromCursor> }
  | { readonly _tag: "invalid_cursor" }
  | { readonly _tag: "error"; readonly cause: unknown } {
  try {
    return { _tag: "ok", page: selectHistoryPageFromCursor(input) };
  } catch (cause) {
    if (cause instanceof InvalidThreadHistoryCursorError) {
      return { _tag: "invalid_cursor" };
    }
    return { _tag: "error", cause };
  }
}

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket; gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const projects = yield* projectionSnapshotQuery.getProjectShellsWithoutEnrichment();
          const threads = yield* threadManagement
            .getShellSnapshot({ location: "active" })
            .pipe(Effect.map(ThreadManagementService.userFacingShellSnapshot));
          return buildActiveShellSnapshot({
            projects,
            threads,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
          });
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      return { ...base, projects };
    });

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot().pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          );
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_bounded_snapshot_failed",
          );
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: bounded.projection,
            historyCursor: bounded.historyCursor,
            hasMoreHistory: bounded.hasMoreHistory,
            latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
          };
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_history_failed",
          );
          const pageOrError = selectHistoryPageFromCursorOrError({
            items: snapshot.projection.visibleTurnItems,
            cursor: args.query.cursor,
            snapshotSequence: snapshot.snapshotSequence,
          });
          if (pageOrError._tag === "invalid_cursor") {
            return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
          }
          if (pageOrError._tag === "error") {
            return yield* failEnvironmentInternal(
              "orchestration_thread_history_failed",
              pageOrError.cause,
            );
          }
          return {
            snapshotSequence: snapshot.snapshotSequence,
            items: pageOrError.page.items,
            nextCursor: pageOrError.page.nextCursor,
            hasMoreHistory: pageOrError.page.hasMoreHistory,
          };
        }),
      );
  }),
);

import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type AuthSessionId,
  type OrchestrationProjectShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpApiSchemaError } from "effect/http-api/HttpApiError";
import * as SqlClient from "effect/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  failEnvironmentOperationForbidden,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as TeamService from "../team/TeamService.ts";
import {
  adaptThreadProjectionForUpstreamCompat,
  adaptThreadShellsForUpstreamCompat,
  isTeamAwareClientRequest,
} from "../team/upstreamMobileCompat.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  loadShellUnlessResumable,
  loadSubscriberShellSnapshot,
  projectIdentitiesDigest,
} from "./ShellStream.ts";
import { encodeThreadSnapshotBody } from "./threadSnapshotBody.ts";
import { boundedSnapshotResponseFields } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const isInvalidThreadHistoryCursorError = Schema.is(InvalidThreadHistoryCursorError);

const isThreadTranscriptTooLargeError = Schema.is(
  ThreadManagementService.ThreadTranscriptTooLargeError,
);

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const teamServiceOption = yield* Effect.serviceOption(TeamService.TeamService);

    const assertTeamThreadReadable = Effect.fn("http.orchestration.assertTeamThreadReadable")(
      function* (sessionId: AuthSessionId, threadId: ThreadId) {
        if (Option.isNone(teamServiceOption)) return;
        const readable = yield* teamServiceOption.value.canReadThread(sessionId, threadId);
        if (!readable) {
          return yield* failEnvironmentOperationForbidden("team_thread_access_denied");
        }
      },
    );

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use available enrichment only; git probes can take a minute and exceed shell-snapshot budgets.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* (
      sessionId: AuthSessionId,
      options: {
        readonly omitIdleSubagents: boolean;
        readonly omitOlderSettled: boolean;
        readonly upstreamCompat: boolean;
      },
    ) {
      const isTeam =
        Option.isSome(teamServiceOption) && (yield* teamServiceOption.value.isTeamConfigured());
      // Pre-filter the active shell index before computing olderSettled cutoff & counts so
      // colleagues' hidden/unfollowed threads never inflate counts or push visible threads past the cap.
      const listShellIndex = isTeam
        ? threadManagement.listActiveShellIndex().pipe(
            Effect.flatMap((rows) =>
              teamServiceOption.value
                .filterVisibleShellThreadIds(
                  sessionId,
                  rows.map((row) => row.id),
                  { upstreamCompat: options.upstreamCompat },
                )
                .pipe(Effect.map((visibleIds) => rows.filter((row) => visibleIds.has(row.id)))),
            ),
          )
        : threadManagement.listActiveShellIndex();
      const { snapshot } = yield* loadSubscriberShellSnapshot({
        sql,
        listShellIndex,
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({
            location: "active",
            ...(threadIds === undefined ? {} : { threadIds }),
          }),
        listProjects: projectStore.listShells(),
        latestSequence: applicationEvents.latestApplicationSequence,
        options,
      });
      const filteredThreads = isTeam
        ? yield* teamServiceOption.value
            .filterVisibleShellThreadIds(
              sessionId,
              snapshot.threads.map((thread) => thread.id),
              { upstreamCompat: options.upstreamCompat },
            )
            .pipe(
              Effect.map((visibleIds) =>
                snapshot.threads.filter((thread) => visibleIds.has(thread.id)),
              ),
              Effect.flatMap((threads) =>
                adaptThreadShellsForUpstreamCompat(
                  teamServiceOption.value,
                  threads,
                  options.upstreamCompat,
                  sessionId,
                ),
              ),
            )
        : snapshot.threads;
      const projects = yield* enrichProjectShells(snapshot.projects);
      return {
        ...snapshot,
        threads: filteredThreads,
        projects,
        projectIdentities: projectIdentitiesDigest(projects),
      };
    });

    // A client that holds rows names their cursor; a small answer tells it to keep them.
    const answerShellSnapshot = Effect.fn("http.orchestration.answerShellSnapshot")(function* (
      sessionId: AuthSessionId,
      query: {
        readonly omitIdleSubagents?: string;
        readonly omitOlderSettled?: string;
        readonly resumeFrom?: string;
      },
      upstreamCompat: boolean,
    ) {
      const isTeam =
        Option.isSome(teamServiceOption) && (yield* teamServiceOption.value.isTeamConfigured());
      const resumeFrom = query.resumeFrom === undefined ? Number.NaN : Number(query.resumeFrom);
      return yield* loadShellUnlessResumable({
        events: applicationEvents,
        resumeFrom:
          !isTeam && Number.isSafeInteger(resumeFrom) && resumeFrom >= 0 ? resumeFrom : undefined,
        loadSnapshot: loadShellSnapshot(sessionId, {
          omitIdleSubagents: query.omitIdleSubagents === "1",
          omitOlderSettled: query.omitOlderSettled === "1",
          upstreamCompat,
        }),
      });
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

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
        deferWork = false,
      ) {
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            deferWork,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const upstreamCompat = !isTeamAwareClientRequest(
            request,
            Option.getOrNull(requestUrl(request)),
          );
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* answerShellSnapshot(session.sessionId, args.query, upstreamCompat).pipe(
            traceLocalHandlerWork,
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
          const request = yield* HttpServerRequest.HttpServerRequest;
          const upstreamCompat = !isTeamAwareClientRequest(
            request,
            Option.getOrNull(requestUrl(request)),
          );
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* assertTeamThreadReadable(session.sessionId, args.params.threadId);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          );
          const projection = Option.isSome(teamServiceOption)
            ? yield* adaptThreadProjectionForUpstreamCompat(
                teamServiceOption.value,
                snapshot.projection,
                upstreamCompat,
                session.sessionId,
              )
            : snapshot.projection;
          const body = yield* encodeThreadSnapshotBody({
            snapshotSequence: snapshot.snapshotSequence,
            projection,
          }).pipe(
            // The same defect, and the same empty 500, as a failed response encoding.
            Effect.catch((cause) => Effect.die(new HttpApiSchemaError({ kind: "Body", cause }))),
            traceLocalHandlerWork,
          );
          return HttpServerResponse.stream(body, { contentType: "application/json" });
        }),
      )
      .handle(
        "threadTranscript",
        Effect.fn("environment.orchestration.threadTranscript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const upstreamCompat = !isTeamAwareClientRequest(
            request,
            Option.getOrNull(requestUrl(request)),
          );
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* assertTeamThreadReadable(session.sessionId, args.params.threadId);
          const transcript = yield* threadManagement.getThreadTranscript(args.params.threadId).pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
            traceLocalHandlerWork,
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadTranscriptTooLargeError(error)) {
                  return yield* failEnvironmentInvalidRequest("thread_transcript_too_large");
                }
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal(
                  "orchestration_thread_snapshot_failed",
                  error,
                );
              }),
            ),
          );
          if (Option.isSome(teamServiceOption) && upstreamCompat) {
            const title = yield* teamServiceOption.value.formatUpstreamCompatThreadTitle(
              args.params.threadId,
              transcript.title,
            );
            return { ...transcript, title };
          }
          return transcript;
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const upstreamCompat = !isTeamAwareClientRequest(
            request,
            Option.getOrNull(requestUrl(request)),
          );
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* assertTeamThreadReadable(session.sessionId, args.params.threadId);
          const rawSnapshot = yield* loadThreadSnapshotWindow(
            args.params.threadId,
            undefined,
            undefined,
            args.query.deferWork === "1",
          ).pipe(traceLocalHandlerWork);
          const projection = Option.isSome(teamServiceOption)
            ? yield* adaptThreadProjectionForUpstreamCompat(
                teamServiceOption.value,
                rawSnapshot.projection,
                upstreamCompat,
                session.sessionId,
              )
            : rawSnapshot.projection;
          const bounded = buildBoundedThreadProjection({
            projection,
            snapshotSequence: rawSnapshot.snapshotSequence,
          });
          return {
            snapshotSequence: rawSnapshot.snapshotSequence,
            ...boundedSnapshotResponseFields({
              bounded,
              compactTurnItems: args.query.compactTurnItems === "1",
              dedupeBodies: args.query.dedupeBodies === "1",
              compactIds: args.query.compactIds === "1",
            }),
          };
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* assertTeamThreadReadable(session.sessionId, args.params.threadId);
          const decoded = Result.try(() => decodeThreadHistoryCursor(args.query.cursor));
          if (Result.isFailure(decoded)) {
            const cause = decoded.failure;
            if (isInvalidThreadHistoryCursorError(cause))
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
          }
          return yield* threadManagement
            .getThreadHistoryPage(
              args.params.threadId,
              args.query.cursor,
              args.query.throughEntryId,
              args.query.view === "conversation",
              args.query.view === "work"
                ? "work"
                : args.query.deferWork === "1"
                  ? "deferred"
                  : undefined,
            )
            .pipe(
              Effect.map((page) =>
                args.query.compactIds === "1" ? { ...page, idTable: true as const } : page,
              ),
              traceLocalHandlerWork,
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  if (isThreadNotFound(cause))
                    return yield* failEnvironmentNotFound("thread_not_found");
                  return yield* failEnvironmentInternal(
                    "orchestration_thread_history_failed",
                    cause,
                  );
                }),
              ),
            );
        }),
      );
  }),
);

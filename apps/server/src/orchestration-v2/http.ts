import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type EnvironmentResourceNotFoundError,
  type OrchestrationV2Command,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
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
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { loadSubscriberShellSnapshot } from "./ShellStream.ts";
import { boundedSnapshotResponseFields } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

/** Fork: the host serves snapshots but not the thread-intake services. */
class ThreadIntakeUnavailableError extends Schema.TaggedError<ThreadIntakeUnavailableError>()(
  "ThreadIntakeUnavailableError",
  {},
) {}

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
    // Fork: HTTP dispatch/launch (`t3 thread start|send`, local scripts). The
    // intake services are optional so narrow hosts (tests) that serve only the
    // snapshot routes still build; there the fork routes report unavailable.
    const intakeServices = yield* Effect.all({
      launches: Effect.serviceOption(ThreadLaunchService.ThreadLaunchService),
      config: Effect.serviceOption(ServerConfig.ServerConfig),
      fileSystem: Effect.serviceOption(FileSystem.FileSystem),
      documentText: Effect.serviceOption(DocumentText.DocumentText),
    });
    const intakeContext =
      Option.isSome(intakeServices.launches) &&
      Option.isSome(intakeServices.config) &&
      Option.isSome(intakeServices.fileSystem) &&
      Option.isSome(intakeServices.documentText)
        ? Option.some(
            Context.make(ThreadManagementService.ThreadManagementService, threadManagement).pipe(
              Context.add(ThreadLaunchService.ThreadLaunchService, intakeServices.launches.value),
              Context.add(ServerConfig.ServerConfig, intakeServices.config.value),
              Context.add(FileSystem.FileSystem, intakeServices.fileSystem.value),
              Context.add(DocumentText.DocumentText, intakeServices.documentText.value),
            ),
          )
        : Option.none();
    const withIntake = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | FileSystem.FileSystem
        | ServerConfig.ServerConfig
        | DocumentText.DocumentText
      >,
    ): Effect.Effect<A, E | ThreadIntakeUnavailableError> =>
      Option.isSome(intakeContext)
        ? effect.pipe(Effect.provide(intakeContext.value))
        : Effect.fail(new ThreadIntakeUnavailableError());

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

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(
      function* (options: {
        readonly omitIdleSubagents: boolean;
        readonly omitOlderSettled: boolean;
      }) {
        const { snapshot } = yield* loadSubscriberShellSnapshot({
          sql,
          listShellIndex: threadManagement.listActiveShellIndex(),
          readThreads: (threadIds) =>
            threadManagement.readShellSnapshot({
              location: "active",
              ...(threadIds === undefined ? {} : { threadIds }),
            }),
          listProjects: projectStore.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
          options,
        });
        const projects = yield* enrichProjectShells(snapshot.projects);
        return { ...snapshot, projects };
      },
    );

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
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          // HttpApi narrows a union payload's static type; the decoded value is any command.
          const command = args.payload as OrchestrationV2Command;
          const result = yield* ThreadMessageIntake.dispatchCommand(
            ThreadManagementService.withCreationProvenance(command, {
              createdBy: "user",
              creationSource: "creationSource" in command ? command.creationSource : "server",
            }),
          ).pipe(
            withIntake,
            Effect.catch(
              (
                cause,
              ): Effect.Effect<
                never,
                EnvironmentInternalError | EnvironmentResourceNotFoundError
              > =>
                isThreadNotFound(cause)
                  ? failEnvironmentNotFound("thread_not_found")
                  : failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          return { sequence: result.sequence };
        }),
      )
      .handle(
        "launchThread",
        Effect.fn("environment.orchestration.launchThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const input = args.payload;
          const result = yield* ThreadMessageIntake.launchThread({
            commandId: input.commandId,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.reuseExistingThread === undefined
              ? {}
              : { reuseExistingThread: input.reuseExistingThread }),
            projectId: input.projectId,
            title: input.title,
            ...(input.generateTitle === undefined ? {} : { generateTitle: input.generateTitle }),
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            workspaceStrategy: input.workspaceStrategy,
            ...(input.initialMessage === undefined
              ? {}
              : {
                  initialMessage: {
                    ...(input.initialMessage.messageId === undefined
                      ? {}
                      : { messageId: input.initialMessage.messageId }),
                    text: input.initialMessage.text,
                    attachments: input.initialMessage.attachments,
                    ...(input.initialMessage.context === undefined
                      ? {}
                      : { context: input.initialMessage.context }),
                  },
                }),
            createdBy: "user",
            creationSource: input.creationSource ?? "server",
          }).pipe(
            withIntake,
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          return { threadId: result.threadId };
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot({
            omitIdleSubagents: args.query.omitIdleSubagents === "1",
            omitOlderSettled: args.query.omitOlderSettled === "1",
          }).pipe(
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
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          ).pipe(traceLocalHandlerWork);
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      )
      .handle(
        "threadTranscript",
        Effect.fn("environment.orchestration.threadTranscript")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* threadManagement.getThreadTranscript(args.params.threadId).pipe(
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
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshotWindow(
            args.params.threadId,
            undefined,
            undefined,
            args.query.deferWork === "1",
          ).pipe(traceLocalHandlerWork);
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          return {
            snapshotSequence: snapshot.snapshotSequence,
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
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
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

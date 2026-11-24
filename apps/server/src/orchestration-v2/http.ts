import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  DEFAULT_RUNTIME_MODE,
  EnvironmentHttpApi,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpApiSchemaError } from "effect/http-api/HttpApiError";
import * as SqlClient from "effect/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import { isProviderSignOutPrompt } from "./CommandPolicy.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
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
  if (
    Predicate.hasProperty(error, "_tag") &&
    error._tag === "ThreadManagementThreadNotFoundError"
  ) {
    return true;
  }
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

function isCommandRejectedError(error: unknown): boolean {
  if (!Predicate.hasProperty(error, "_tag") || typeof error._tag !== "string") return false;
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "OrchestratorProviderSelectionBusyError":
    case "OrchestratorRuntimeModeAboveCeilingError":
    case "ThreadManagementProviderInstanceDisabledError":
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
    case "ThreadManagementRunOutputRejectedError":
      return true;
    default:
      return false;
  }
}

function commandRequiresProvidersManageScope(command: OrchestrationV2Command): boolean {
  switch (command.type) {
    case "message.dispatch":
      return isProviderSignOutPrompt(command);
    case "queued-run.edit":
      return isProviderSignOutPrompt({
        text: command.text,
        attachments: command.attachments ?? [],
      });
    case "delegated_task.request":
      return isProviderSignOutPrompt({ text: command.task, attachments: [] });
    default:
      return false;
  }
}

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

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
        return { ...snapshot, projects, projectIdentities: projectIdentitiesDigest(projects) };
      },
    );

    // A client that holds rows names their cursor; a small answer tells it to keep them.
    const answerShellSnapshot = Effect.fn("http.orchestration.answerShellSnapshot")((query: {
      readonly omitIdleSubagents?: string;
      readonly omitOlderSettled?: string;
      readonly resumeFrom?: string;
    }) => {
      const resumeFrom = query.resumeFrom === undefined ? Number.NaN : Number(query.resumeFrom);
      return loadShellUnlessResumable({
        events: applicationEvents,
        resumeFrom: Number.isSafeInteger(resumeFrom) && resumeFrom >= 0 ? resumeFrom : undefined,
        loadSnapshot: loadShellSnapshot({
          omitIdleSubagents: query.omitIdleSubagents === "1",
          omitOlderSettled: query.omitOlderSettled === "1",
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
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* answerShellSnapshot(args.query).pipe(
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
          const body = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          ).pipe(
            Effect.flatMap((snapshot) =>
              encodeThreadSnapshotBody({
                snapshotSequence: snapshot.snapshotSequence,
                projection: snapshot.projection,
              }).pipe(
                // The same defect, and the same empty 500, as a failed response encoding.
                Effect.catch((cause) =>
                  Effect.die(new HttpApiSchemaError({ kind: "Body", cause })),
                ),
              ),
            ),
            traceLocalHandlerWork,
          );
          return HttpServerResponse.stream(body, { contentType: "application/json" });
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
      )
      .handle(
        "dispatchCommand",
        Effect.fn("environment.orchestration.dispatchCommand")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const incoming = args.payload;
          if (
            commandRequiresProvidersManageScope(incoming) &&
            !session.scopes.has(AuthProvidersManageScope)
          ) {
            return yield* failEnvironmentScopeRequired(AuthProvidersManageScope);
          }
          const command = ThreadManagementService.withCreationProvenance(incoming, {
            createdBy: "user",
            creationSource: "creationSource" in incoming ? incoming.creationSource : "web",
          });
          return yield* threadManagement.dispatch(command).pipe(
            Effect.map((result) => ({ sequence: result.sequence })),
            traceLocalHandlerWork,
            Effect.catch(
              Effect.fnUntraced(function* (cause) {
                if (isThreadNotFound(cause)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                if (isCommandRejectedError(cause)) {
                  return yield* failEnvironmentInvalidRequest("invalid_command");
                }
                return yield* failEnvironmentInternal("orchestration_command_failed", cause);
              }),
            ),
          );
        }),
      )
      .handle(
        "launchThread",
        Effect.fn("environment.orchestration.launchThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const { payload } = args;
          if (
            payload.message !== undefined &&
            isProviderSignOutPrompt({ text: payload.message, attachments: [] }) &&
            !session.scopes.has(AuthProvidersManageScope)
          ) {
            return yield* failEnvironmentScopeRequired(AuthProvidersManageScope);
          }
          const projectOption = yield* projectStore
            .getShell(payload.projectId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_launch_failed", cause),
              ),
            );
          if (Option.isNone(projectOption)) {
            return yield* failEnvironmentNotFound("project_not_found");
          }
          const project = projectOption.value;
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_launch_failed", cause),
            ),
          );
          const effectiveProjectSettings = resolveProjectSettings(
            settings,
            payload.projectId,
            project,
          ).settings;
          const providers = yield* providerRegistry.getProviders;
          const resolvedModel = resolveNewThreadModelSelection({
            defaultSelection: effectiveProjectSettings.defaultModelSelection,
            fallbackSelection: effectiveProjectSettings.fallbackModelSelection,
            providers,
            settings: effectiveProjectSettings,
            projectId: payload.projectId,
            now: DateTime.toEpochMillis(yield* DateTime.now),
          }).selection;
          if (resolvedModel === null) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          const trimmedMessage = payload.message?.trim();
          const title =
            payload.title ??
            (trimmedMessage && trimmedMessage.length > 0
              ? trimmedMessage.slice(0, 80)
              : `New ${project.title} thread`);
          return yield* threadLaunch
            .launch({
              commandId: payload.commandId,
              ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
              projectId: payload.projectId,
              title,
              generateTitle: payload.title === undefined && Boolean(trimmedMessage),
              ...(payload.title === undefined ? {} : { titleRenamed: true }),
              modelSelection: resolvedModel,
              runtimeMode: effectiveProjectSettings.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE,
              interactionMode: payload.interactionMode ?? "default",
              workspaceStrategy: { type: "root" },
              ...(trimmedMessage && trimmedMessage.length > 0
                ? {
                    initialMessage: {
                      text: trimmedMessage,
                      attachments: [],
                    },
                  }
                : {}),
              createdBy: "user",
              creationSource: payload.creationSource ?? "web",
            })
            .pipe(
              Effect.map((result) => ({
                threadId: result.threadId,
                projectId: payload.projectId,
                title: result.projection.thread.title,
                resumed: result.resumed,
                ...(result.sequence === undefined ? {} : { sequence: result.sequence }),
              })),
              traceLocalHandlerWork,
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  if (isCommandRejectedError(cause)) {
                    return yield* failEnvironmentInvalidRequest("invalid_command");
                  }
                  return yield* failEnvironmentInternal(
                    "orchestration_thread_launch_failed",
                    cause,
                  );
                }),
              ),
            );
        }),
      )
      .handle(
        "sendThreadMessage",
        Effect.fn("environment.orchestration.sendThreadMessage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const { payload } = args;
          if (
            isProviderSignOutPrompt({ text: payload.text, attachments: [] }) &&
            !session.scopes.has(AuthProvidersManageScope)
          ) {
            return yield* failEnvironmentScopeRequired(AuthProvidersManageScope);
          }
          const shell = yield* threadManagement.getThreadShell(args.params.threadId).pipe(
            Effect.catch(
              Effect.fnUntraced(function* (cause) {
                if (isThreadNotFound(cause)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_message_send_failed", cause);
              }),
            ),
          );
          if (shell === null || shell.deletedAt !== null) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const messageId = payload.messageId ?? MessageId.make(`msg-${payload.commandId}`);
          return yield* threadManagement
            .sendToThread({
              projectId: shell.projectId,
              commandId: payload.commandId,
              threadId: args.params.threadId,
              messageId,
              text: payload.text,
              attachments: [],
              mode: payload.mode ?? "auto",
              createdBy: "user",
              creationSource: payload.creationSource ?? "web",
            })
            .pipe(
              Effect.map((result) => ({
                threadId: args.params.threadId,
                messageId: result.message.id,
                runId: result.run.id,
                delivery: result.delivery,
              })),
              traceLocalHandlerWork,
              Effect.catch(
                Effect.fnUntraced(function* (cause) {
                  if (isThreadNotFound(cause)) {
                    return yield* failEnvironmentNotFound("thread_not_found");
                  }
                  if (isCommandRejectedError(cause)) {
                    return yield* failEnvironmentInvalidRequest("invalid_command");
                  }
                  return yield* failEnvironmentInternal("orchestration_message_send_failed", cause);
                }),
              ),
            );
        }),
      );
  }),
);

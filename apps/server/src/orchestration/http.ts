import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import {
  type ProviderInstanceNotFoundError,
  type ProviderSessionWakeTargetError,
  type ProviderUnsupportedError,
  type ProviderWorkspaceMissingError,
  type ProviderServiceError,
} from "../provider/Errors.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

type MappedProviderSessionWakeError =
  | ProviderSessionWakeTargetError
  | ProviderWorkspaceMissingError
  | ProviderInstanceNotFoundError
  | ProviderUnsupportedError;

const isUnexpectedProviderSessionWakeError = (
  cause: ProviderServiceError,
): cause is Exclude<ProviderServiceError, MappedProviderSessionWakeError> => {
  switch (cause._tag) {
    case "ProviderSessionWakeTargetError":
    case "ProviderWorkspaceMissingError":
    case "ProviderInstanceNotFoundError":
    case "ProviderUnsupportedError":
      return false;
    default:
      return true;
  }
};

const mapProviderSessionWakeTargetError = (
  cause: ProviderSessionWakeTargetError,
): Effect.Effect<never, EnvironmentRequestInvalidError | EnvironmentResourceNotFoundError> => {
  switch (cause.reason) {
    case "not_found":
      return failEnvironmentNotFound("provider_session_not_found");
    case "thread_unavailable":
      return failEnvironmentNotFound("thread_unavailable");
    case "ambiguous":
      return failEnvironmentInvalidRequest("ambiguous_provider_session");
    case "instance_unavailable":
      return failEnvironmentInvalidRequest("provider_instance_unavailable");
  }
};

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const providerService = yield* ProviderService.ProviderService;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
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
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      )
      .handle(
        "wakeProviderSession",
        Effect.fn("environment.orchestration.wakeProviderSession")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* providerService.wakeSession(args.payload).pipe(
            Effect.catchIf(isUnexpectedProviderSessionWakeError, (cause) =>
              failEnvironmentInternal("orchestration_provider_session_wake_failed", cause),
            ),
            Effect.catchTag("ProviderSessionWakeTargetError", mapProviderSessionWakeTargetError),
            Effect.catchTag("ProviderWorkspaceMissingError", () =>
              failEnvironmentInvalidRequest("workspace_missing"),
            ),
            Effect.catchTag("ProviderInstanceNotFoundError", () =>
              failEnvironmentInvalidRequest("provider_instance_unavailable"),
            ),
            Effect.catchTag("ProviderUnsupportedError", () =>
              failEnvironmentInvalidRequest("provider_instance_unavailable"),
            ),
          );
        }),
      );
  }),
);

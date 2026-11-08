import {
  AcpRegistryOperationError,
  CommandId,
  type AcpRegistryImportSessionInput,
  type AcpRegistryImportSessionResult,
  type Project,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export const importedThreadId = (input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: string;
}) =>
  IdAllocator.deriveThreadFromProviderThread({
    driver: input.driver,
    providerInstanceId: input.instanceId,
    nativeThreadId: input.sessionId,
  });

export class AcpRegistrySessions extends Context.Service<
  AcpRegistrySessions,
  {
    readonly project: (projectId: ProjectId) => Effect.Effect<Project, AcpRegistryOperationError>;
    readonly sessionManager: (instanceId: ProviderInstanceId) => Effect.Effect<
      {
        readonly instance: ProviderInstance;
        readonly manager: NonNullable<ProviderInstance["acpSessionManagement"]>;
      },
      AcpRegistryOperationError
    >;
    /**
     * Binds a native ACP session to a T3 thread and copies its history in. Importing a
     * session whose thread still lacks its history repairs that thread instead.
     */
    readonly importSession: (
      input: AcpRegistryImportSessionInput,
    ) => Effect.Effect<AcpRegistryImportSessionResult, AcpRegistryOperationError>;
  }
>()("t3/provider/AcpRegistrySessions") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
  const crypto = yield* Crypto.Crypto;

  const project = Effect.fn("AcpRegistrySessions.project")(function* (projectId: ProjectId) {
    const found = yield* projectService.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "project_not_found",
            message: `Project ${projectId} is unavailable.`,
            cause,
          }),
      ),
    );
    return yield* Effect.fromOption(
      found,
      () =>
        new AcpRegistryOperationError({
          reason: "project_not_found",
          message: `Project ${projectId} was not found.`,
        }),
    );
  });

  const sessionManager = Effect.fn("AcpRegistrySessions.sessionManager")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "instance_not_found",
        message: `Provider instance ${instanceId} was not found.`,
      });
    }
    if (instance.acpSessionManagement === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: `Provider instance ${instanceId} does not expose ACP session management.`,
      });
    }
    return { instance, manager: instance.acpSessionManagement };
  });

  const importSession = Effect.fn("AcpRegistrySessions.importSession")(function* (
    input: AcpRegistryImportSessionInput,
  ) {
    const { workspaceRoot } = yield* project(input.projectId);
    const { instance } = yield* sessionManager(input.instanceId);
    const providerSnapshot = yield* instance.snapshot.getSnapshot;
    if (
      providerSnapshot.nativeSessions?.canLoad !== true &&
      providerSnapshot.nativeSessions?.canResume !== true
    ) {
      return yield* new AcpRegistryOperationError({
        reason: "session_resume_unsupported",
        message: "The ACP agent cannot load or resume native sessions.",
      });
    }
    const threadId = importedThreadId({
      driver: instance.driverKind,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
    });
    const existing = yield* threadManagement.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "session_import_failed",
            message: "Could not inspect the imported ACP session mapping.",
            cause,
          }),
      ),
    );
    if (existing !== null) {
      const repairing = AgentSessionImporter.isNativeHistoryPending({
        historyOrigin: existing.historyOrigin,
        hasRun: existing.latestRunId !== null,
      });
      yield* agentSessionImporter.importNativeHistory({ threadId, workspaceRoot }).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_import_failed",
              message: "Could not import the ACP session history.",
              cause,
            }),
        ),
      );
      return { threadId, imported: repairing } as const;
    }

    const provider = (yield* providerRegistry.getProviders).find(
      (candidate) => candidate.instanceId === input.instanceId,
    );
    const model =
      provider?.models.find((candidate) => candidate.isDefault)?.slug ??
      provider?.models[0]?.slug ??
      "default";
    const commandId = CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
    const launched = yield* Effect.result(
      startup.enqueueCommand(
        threadLaunch.launch({
          commandId,
          threadId,
          projectId: input.projectId,
          title: input.title ?? "Imported ACP session",
          modelSelection: { instanceId: input.instanceId, model },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          importedNativeThread: {
            ref: {
              driver: instance.driverKind,
              nativeId: input.sessionId,
              strength: "strong",
            },
            metadata: {
              itemIdentityVersion: 2,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
            },
          },
          createdBy: "user",
          creationSource: "web",
        }),
      ),
    );
    if (Result.isFailure(launched)) {
      const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_import_failed",
              message: "Could not inspect the imported ACP session after launch failed.",
              cause,
            }),
        ),
      );
      if (racedImport !== null) return { threadId, imported: false } as const;
      return yield* new AcpRegistryOperationError({
        reason: "session_import_failed",
        message: "Could not create a T3 thread for the ACP session.",
        cause: launched.failure,
      });
    }
    // The thread is usable without its history, so a failed read only logs.
    yield* agentSessionImporter.importNativeHistory({ threadId, workspaceRoot }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not import ACP session history", {
          instanceId: input.instanceId,
          sessionId: input.sessionId,
          cause,
        }),
      ),
    );
    return { threadId, imported: true } as const;
  }, coordinator.withSessionMutation);

  return AcpRegistrySessions.of({ project, sessionManager, importSession });
});

export const layer = Layer.effect(AcpRegistrySessions, make);

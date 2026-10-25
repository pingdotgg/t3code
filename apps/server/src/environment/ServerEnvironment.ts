import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveServerInstallation } from "../cli/invocation.ts";
import { readAgentActivityPublishingActive } from "../cloud/config.ts";
import { resolveServerSelfUpdateCapability } from "../cloud/selfUpdate.ts";
import { resolveServiceLauncherMode } from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";
import { detectServerEnvironmentMachineKind } from "./ServerEnvironmentMachine.ts";

export class ServerEnvironmentIdPersistenceError extends Schema.TaggedError<ServerEnvironmentIdPersistenceError>()(
  "ServerEnvironmentIdPersistenceError",
  {
    operation: Schema.Literals(["check", "read", "write", "initialize"]),
    environmentIdPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "initialize") {
      return `Server environment ID file is missing or empty after initialization at '${this.environmentIdPath}'.`;
    }
    return `Server environment ID ${this.operation} failed at '${this.environmentIdPath}'.`;
  }
}

export class ServerEnvironment extends Context.Service<
  ServerEnvironment,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
    readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
  }
>()("t3/environment/ServerEnvironment") {}

export class ServerEnvironmentIdentity extends Context.Service<
  ServerEnvironmentIdentity,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  }
>()("t3/environment/ServerEnvironment/ServerEnvironmentIdentity") {}

function platformOs(platform: NodeJS.Platform): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

function platformArch(
  architecture: NodeJS.Architecture,
): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  switch (architecture) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
}

const makeIdentity = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(serverConfig.environmentIdPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "check",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem.readFileString(serverConfig.environmentIdPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "read",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = Effect.fn("ServerEnvironmentIdentity.persistEnvironmentId")(
    function* (value: string, mode: "create" | "recover") {
      const destinationPath =
        mode === "recover"
          ? `${serverConfig.environmentIdPath}.recovery`
          : serverConfig.environmentIdPath;
      const tempPath = yield* fileSystem.makeTempFileScoped({
        directory: serverConfig.stateDir,
        prefix: ".environment-id-",
      });
      yield* fileSystem.writeFileString(tempPath, `${value}\n`);
      // Publish the completed file without replacing an ID created by another process.
      yield* fileSystem.link(tempPath, destinationPath).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
      if (mode === "recover") {
        // Keep the recovery ID so delayed initializers also publish the same winner.
        yield* fileSystem.remove(tempPath);
        yield* fileSystem.copyFile(destinationPath, tempPath);
        yield* fileSystem.rename(tempPath, serverConfig.environmentIdPath);
      }
    },
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new ServerEnvironmentIdPersistenceError({
          operation: "write",
          environmentIdPath: serverConfig.environmentIdPath,
          cause,
        }),
    ),
  );

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = yield* crypto.randomUUIDv4();
    yield* persistEnvironmentId(generated, "create");
    let winner = yield* readPersistedEnvironmentId;
    if (winner === null) {
      yield* persistEnvironmentId(generated, "recover");
      winner = yield* readPersistedEnvironmentId;
    }
    if (winner === null) {
      return yield* new ServerEnvironmentIdPersistenceError({
        operation: "initialize",
        environmentIdPath: serverConfig.environmentIdPath,
      });
    }
    return winner;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  return ServerEnvironmentIdentity.of({
    getEnvironmentId: Effect.succeed(environmentId),
  });
});

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironmentIdentity;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  const environmentId = yield* identity.getEnvironmentId;
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const label = yield* resolveServerEnvironmentLabel({ cwdBaseName });
  const machine = yield* detectServerEnvironmentMachineKind();
  const launcher = yield* resolveServiceLauncherMode();
  const serverSelfUpdate = resolveServerSelfUpdateCapability({
    desktopManaged: serverConfig.mode === "desktop",
    launcherManaged: launcher.managed,
  });
  const serverInstallation = serverSelfUpdate === null ? yield* resolveServerInstallation : null;
  // Desktop and server ship together; a control fd guarantees requestDesktopUpdate support.

  const desktopAppUpdate =
    serverSelfUpdate === "desktop-managed" && serverConfig.desktopTelemetryControlFd !== undefined;

  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId,
    label,
    platform: {
      os: platformOs(hostPlatform),
      arch: platformArch(hostArchitecture),
      ...(machine === null ? {} : { machine }),
    },
    serverVersion: packageJson.version,
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
      attachmentUploads: true,
      questionAttachments: true,
      fileAttachments: { maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES },
      pullRequests: true,
      pullRequestChecks: true,
      inlineMessageContext: true,
      requiredWorktreeBootstrap: true,
      threadSettlement: true,
      threadAutoSettlement: true,
      storageCleanup: true,
      storageCleanupRun: true,
      databaseStorage: true,
      otlpEndpointCheck: true,
      projectWorktreeCleanup: true,
      settledWorktreeCleanup: true,
      worktreesDirectory: true,
      threadAutoSettlementScope: true,
      threadRestartContinuation: true,
      projectSettingsOverrides: true,
      projectProviderInstanceOverrides: true,
      threadSnooze: true,
      environmentThemes: true,
      usageLimitSources: true,
      providerWorkspaceSnapshotsOnDemand: true,
      usagePriceOverrides: true,
      usageModelAliases: true,
      threadPinning: true,
      threadPinReorder: true,
      threadActiveReorder: true,
      threadAutoSettleOptOut: true,
      threadTitleRegeneration: true,
      commandOutputStreaming: true,
      threadVisitedTracking: true,
      threadPullRequests: true,
      threadPullRequestWatch: true,
      pullRequestStackActions: true,
      threadPullRequestLinking: true,
      serverResolvedCommandContext: true,
      threadStop: true,
      environmentIcon: true,
      projectCloneTracking: true,
      ignoredFileListing: true,
      ...(serverSelfUpdate === null ? {} : { serverSelfUpdate }),
      ...(serverInstallation === null ? {} : { serverInstallation }),
      ...(serverSelfUpdate === "boot-service" || desktopAppUpdate
        ? { serverSelfUpdateProgress: true }
        : {}),
      ...(desktopAppUpdate ? { desktopAppUpdate: true } : {}),
      serverBrowser: true,
    },
  };

  return ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    // Publishing opt-in and relay links change at runtime; read the capability per request.
    getDescriptor: readAgentActivityPublishingActive(secrets).pipe(
      Effect.map((agentActivityPublishing) => ({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, agentActivityPublishing },
      })),
    ),
  });
});

export const layerIdentity = Layer.effect(ServerEnvironmentIdentity, makeIdentity);

export const layer = Layer.effect(ServerEnvironment, make).pipe(
  Layer.provideMerge(layerIdentity),
  Layer.provide(ProcessRunner.layer),
);

import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  ServerSecretStore,
  layer as ServerSecretStoreLayer,
} from "../../auth/ServerSecretStore.ts";
import { readAgentActivityPublishingActive } from "../../cloud/config.ts";
import { ServerEnvironment, type ServerEnvironmentShape } from "../Services/ServerEnvironment.ts";
import packageJson from "../../../package.json" with { type: "json" };
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

function platformOs(): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (process.platform) {
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

function platformArch(): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
}

export const makeServerEnvironment = Effect.fn("makeServerEnvironment")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const secrets = yield* ServerSecretStore;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(serverConfig.environmentIdPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem
      .readFileString(serverConfig.environmentIdPath)
      .pipe(Effect.map((value) => value.trim()));

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = (value: string) =>
    fileSystem.writeFileString(serverConfig.environmentIdPath, `${value}\n`);

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = crypto.randomUUID();
    yield* persistEnvironmentId(generated);
    return generated;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const configuredLabel = yield* fileSystem.readFileString(serverConfig.environmentLabelPath).pipe(
    Effect.map((value) => value.trim()),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
    ),
  );
  const installationLabel = process.env.T3CODE_ENVIRONMENT_LABEL_SUFFIX;
  const label = yield* resolveServerEnvironmentLabel({
    cwdBaseName,
    configuredLabel,
    ...(installationLabel === undefined ? {} : { installationLabel }),
  });

  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId,
    label,
    platform: {
      os: platformOs(),
      arch: platformArch(),
    },
    serverVersion: packageJson.version,
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: {
      ownedMobileProtocolVersion: 1,
      repositoryIdentity: true,
      connectionProbe: true,
      pullRequests: true,
      threadPullRequestLinking: true,
      threadSettlement: true,
      threadSnooze: true,
      threadPinning: true,
      threadPinReorder: true,
      threadTitleRegeneration: true,
      agentWorkflows: true,
      threadContext: true,
    },
  };

  return {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: readAgentActivityPublishingActive(secrets).pipe(
      Effect.map((agentActivityPublishing) => ({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          agentActivityPublishing,
        },
      })),
    ),
  } satisfies ServerEnvironmentShape;
});

export const ServerEnvironmentLive = Layer.effect(ServerEnvironment, makeServerEnvironment()).pipe(
  Layer.provide(ServerSecretStoreLayer),
);

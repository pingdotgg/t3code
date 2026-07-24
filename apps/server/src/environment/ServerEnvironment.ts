import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { resolveServerSelfUpdateCapability } from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

export class ServerEnvironmentIdPersistenceError extends Schema.TaggedErrorClass<ServerEnvironmentIdPersistenceError>()(
  "ServerEnvironmentIdPersistenceError",
  {
    operation: Schema.Literals(["check", "read", "write"]),
    environmentIdPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
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

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;

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

  const persistEnvironmentId = (value: string) =>
    fileSystem.writeFileString(serverConfig.environmentIdPath, `${value}\n`).pipe(
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

    const generated = yield* crypto.randomUUIDv4;
    yield* persistEnvironmentId(generated);
    return generated;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const label = yield* resolveServerEnvironmentLabel({ cwdBaseName });
  const serverSelfUpdate = yield* resolveServerSelfUpdateCapability({
    desktopManaged: serverConfig.mode === "desktop",
  });

  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId,
    label,
    platform: {
      os: platformOs(hostPlatform),
      arch: platformArch(hostArchitecture),
    },
    serverVersion: packageJson.version,
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
      threadSettlement: true,
      threadSnooze: true,
      ...(serverSelfUpdate === null ? {} : { serverSelfUpdate }),
    },
  };

  return ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed(descriptor),
  });
});

/**
 * ServerEnvironment is acquired from persisted filesystem and host-process
 * state. It intentionally has no fallback Layer.succeed value: callers must
 * provide the external platform services and a ServerConfig.
 */
export const layer = Layer.effect(ServerEnvironment, make).pipe(Layer.provide(ProcessRunner.layer));

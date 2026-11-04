import {
  ProviderSetupError,
  type CodexSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import type { CodexEffectiveRuntime } from "./CodexManagedRuntime.ts";

export const makeCodexIsolatedRuntime = Effect.fn("makeCodexIsolatedRuntime")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const installer = yield* CodexInstallation.CodexInstallation;
  const installation = yield* installer.managed;
  const server = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeLayout = yield* resolveManagedCodexHomeLayout(
    server.stateDir,
    options.instanceId,
    options.config,
  );
  const homePath = homeLayout.sharedHomePath;
  const config = { ...options.config, homePath, shadowHomePath: "" };
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    CODEX_HOME: homePath,
    CODEX_SQLITE_HOME: path.join(homePath, "sqlite"),
  };
  const resolve = Effect.gen(function* () {
    const executable = yield* installation.acquire().pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: cause.detail,
          }),
      ),
    );
    yield* fs.makeDirectory(homePath, { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: "Could not prepare the separate Codex home.",
          }),
      ),
    );
    return {
      config: { ...config, binaryPath: executable.executablePath },
      environment,
      revision: executable.executablePath,
    } satisfies CodexEffectiveRuntime;
  });
  return { config, environment, homeLayout, resolve };
});

import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { COMMAND_TIMEOUT_MS } from "./CodexManagedTokenProtocol.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
const managedCodexLaunchArgs = (command: string, args: ReadonlyArray<string>) =>
  [
    'model_provider="openai_token_sharing"',
    // Codex persists this provider ID in rollouts and needs it unchanged to resume.
    `model_providers.openai_token_sharing={name="OpenAI Token Sharing",base_url="https://api.openai.com/v1",model_catalog_url="https://api.openai.com/v1/models",wire_api="responses",requires_openai_auth=false,supports_websockets=false,auth={command=${JSON.stringify(command)},args=${JSON.stringify(args)},timeout_ms=${COMMAND_TIMEOUT_MS},refresh_interval_ms=0}}`,
    "features.api_key_model_discovery=true",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");

const quoteShell = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Mirrors the desktop's `t3.cmd`: cmd.exe reads the script in the console code page. */
const windowsLauncherScript = (command: string) => {
  const utf8 = [...command].some((character) => character.codePointAt(0)! > 0x7f);
  const restore = utf8 ? ["chcp %t3_codepage% >nul"] : [];
  return [
    "@echo off",
    "setlocal EnableExtensions DisableDelayedExpansion",
    ...(utf8
      ? [`for /f "tokens=2 delims=:." %%c in ('chcp') do set "t3_codepage=%%c"`, "chcp 65001 >nul"]
      : []),
    'set "ELECTRON_RUN_AS_NODE=1"',
    // cmd.exe expands `%` even inside quotes.
    `"${command.replaceAll("%", "%%")}" %*`,
    'set "t3_exit=%ERRORLEVEL%"',
    ...restore,
    "exit /b %t3_exit%",
    "",
  ].join("\r\n");
};

/**
 * Provider environments drop Electron's run-as-Node mode, and Codex's auth command takes no env,
 * so a desktop server's token command would start the app instead. This restores the mode for it.
 */
const writeElectronNodeLauncher = Effect.fn("CodexManagedRuntime.writeElectronNodeLauncher")(
  function* (directory: string, command: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const windows = (yield* HostProcess.Platform) === "win32";
    const launcherPath = path.join(directory, windows ? "managed-token.cmd" : "managed-token");
    const script = windows
      ? windowsLauncherScript(command)
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(command)} "$@"\n`;
    const current = yield* fs.readFileString(launcherPath).pipe(Effect.orElseSucceed(() => null));
    if (current === script) return launcherPath;
    // Other managed instances' Codex may be running it; replace it whole.
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staged = yield* fs.makeTempFileScoped({ directory, prefix: ".managed-token-" });
        yield* fs.writeFileString(staged, script);
        yield* fs.chmod(staged, 0o755);
        yield* fs.rename(staged, launcherPath);
      }),
    );
    return launcherPath;
  },
);

export const makeCodexManagedRuntime = Effect.fn("makeCodexManagedRuntime")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly config: CodexSettings;
}) {
  const installation = yield* CodexInstallation.CodexInstallation;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environmentIdentity.getEnvironmentId;
  const invocation = yield* resolveSelfInvocation();
  const electronNodeMode = (yield* HostProcess.Environment).ELECTRON_RUN_AS_NODE === "1";
  const auth = yield* makeCodexChatGptAuth({
    instanceId: options.instanceId,
    defaultReturnUrl: new URL(
      "/welcome",
      config.devUrl ?? `http://localhost:${config.port}`,
    ).toString(),
  });
  const homeLayout = yield* resolveManagedCodexHomeLayout(
    config.stateDir,
    options.instanceId,
    options.config,
  );
  const homePath = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
  const resolve = Effect.gen(function* () {
    // Establish renewal availability before auth.access can consume a refresh token.
    const endpoint = yield* broker.endpoint.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail:
              "Could not prepare the private managed Codex token listener. Restart T3 and retry.",
            cause,
          }),
      ),
    );
    const executable = yield* installation.acquire().pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "install",
            detail: "Set up managed Codex before starting a session.",
          }),
      ),
    );
    const credentials = yield* auth.access;
    const profileKey = yield* auth.profileKey(credentials);
    const authArgs = selfInvocationArgs(invocation, [
      "__managed-chatgpt-token",
      endpoint,
      options.instanceId,
      environmentId,
      profileKey,
    ]);
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: cause.message,
          }),
      ),
    );
    yield* fs.makeDirectory(homePath, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: "Could not prepare the managed Codex runtime.",
          }),
      ),
    );
    // Ambient CLI overrides cannot redirect a T3-owned token to a different provider.
    const environment: NodeJS.ProcessEnv = {
      ...options.environment,
      CODEX_HOME: homePath,
    };
    delete environment.ACCESS_TOKEN;
    delete environment.T3CODE_CODEX_LAUNCH_ARGS;
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    const tokenCommand = electronNodeMode
      ? yield* writeElectronNodeLauncher(
          path.join(config.stateDir, "codex", "bin"),
          invocation.command,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "runtime",
                detail: "Could not prepare the managed Codex runtime.",
              }),
          ),
        )
      : invocation.command;
    return {
      config: decodeSettings({
        enabled: options.enabled,
        setupMode: "managed",
        binaryPath: executable.executablePath,
        homePath,
        launchArgs: managedCodexLaunchArgs(tokenCommand, authArgs),
      }),
      environment,
      revision: profileKey,
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});

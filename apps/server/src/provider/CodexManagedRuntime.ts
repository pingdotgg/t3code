import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import {
  CodexSettings,
  isTeamProviderInstanceId,
  ProviderSetupError,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { resolveLocalOrigin } from "../startupAccess.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexChatGptAuth, type CodexChatGptCredentials } from "./CodexChatGptAuth.ts";
import { COMMAND_TIMEOUT_MS } from "./CodexManagedTokenProtocol.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";
import * as TeamProviderManager from "../team/TeamProviderManager.ts";

function makeTeamLeasedCodexAuth(
  instanceId: ProviderInstanceId,
  teamProviderManager: TeamProviderManager.TeamProviderManager["Service"],
): Effect.Success<ReturnType<typeof makeCodexChatGptAuth>> {
  const managedByTeamError = (operation: string) =>
    new ProviderSetupError({
      instanceId,
      operation,
      detail: "Authentication for this Codex provider is managed by your Team Server.",
    });

  const leaseToCredentials = Effect.fn("CodexManagedRuntime.teamLeaseToCredentials")(function* () {
    const lease = yield* teamProviderManager.getLeasedAccessToken(instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId,
            operation: "auth",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const parsedExpiry = Date.parse(lease.expiresAt);
    const expiresAt = Number.isFinite(parsedExpiry)
      ? parsedExpiry
      : nowMs + lease.expiresInSeconds * 1000;
    return {
      clientId: instanceId,
      accessToken: lease.accessToken,
      refreshToken: null,
      expiresAt,
      earliestRefreshAt: null,
      scopes: ["chatgpt.tokens.use.direct"],
      subject: lease.email ?? instanceId,
      email: lease.email ?? null,
    } satisfies CodexChatGptCredentials;
  });

  const controller: Effect.Success<ReturnType<typeof makeCodexChatGptAuth>>["controller"] = {
    credentialBinding: { owner: "t3", key: instanceId },
    withAccess: (task) => task,
    start: () => Effect.fail(managedByTeamError("start")),
    complete: () => Effect.fail(managedByTeamError("complete")),
    cancel: () => Effect.fail(managedByTeamError("cancel")),
    logout: () => Effect.fail(managedByTeamError("logout")),
    subscribe: () => Stream.empty,
    reconnectProfile: () => Effect.succeed(null),
    importProfile: () => Effect.fail(managedByTeamError("import")),
  };

  return {
    controller,
    read: leaseToCredentials().pipe(
      Effect.asSome,
      Effect.catch(() => Effect.succeedNone),
    ) as Effect.Effect<Option.Option<CodexChatGptCredentials>, ProviderSetupError>,
    access: leaseToCredentials(),
    // Keep revision stable across ephemeral lease rotations so CodexManagedProvider's
    // revision check succeeds while CodexManagedTokenBroker delivers fresh tokens in memory.
    profileKey: (_credentials: CodexChatGptCredentials) => Effect.succeed(instanceId as string),
    exportProfile: Effect.fail(managedByTeamError("export")),
    revoke: Effect.void as Effect.Effect<void, ProviderSetupError>,
  };
}

export interface CodexManagedSandboxBinds {
  readonly socketPaths?: ReadonlyArray<string> | undefined;
  readonly providerProfileDirs?: ReadonlyArray<string> | undefined;
  readonly helperPaths?: ReadonlyArray<string> | undefined;
  readonly extraRoBinds?: ReadonlyArray<string> | undefined;
}

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
  readonly sandboxBinds?: CodexManagedSandboxBinds | undefined;
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
  const teamProviderManagerOption = yield* Effect.serviceOption(
    TeamProviderManager.TeamProviderManager,
  );
  const auth =
    isTeamProviderInstanceId(options.instanceId) && Option.isSome(teamProviderManagerOption)
      ? makeTeamLeasedCodexAuth(options.instanceId, teamProviderManagerOption.value)
      : yield* makeCodexChatGptAuth({
          instanceId: options.instanceId,
          defaultReturnUrl: new URL(
            "/welcome",
            config.devUrl ?? resolveLocalOrigin(config.host, config.port),
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
    const helperPaths = [
      invocation.command,
      ...(invocation.entrypoint === undefined ? [] : [invocation.entrypoint]),
    ];
    const hostHome = HostProcess.HomeDirectory.defaultValue();
    const entrypointDir =
      invocation.entrypoint !== undefined && path.isAbsolute(invocation.entrypoint)
        ? path.dirname(invocation.entrypoint)
        : undefined;
    const isUnsafeDir =
      entrypointDir === undefined ||
      new Set([
        "/",
        "/tmp",
        "/var",
        "/var/tmp",
        "/home",
        "/root",
        "/dev",
        "/proc",
        "/etc",
        "/run",
        "/srv",
        "/mnt",
        "/media",
        "/data",
      ]).has(entrypointDir) ||
      (path.isAbsolute(hostHome) &&
        (entrypointDir === hostHome || hostHome.startsWith(`${entrypointDir}/`)));
    const extraRoBinds = isUnsafeDir ? [] : [entrypointDir];
    return {
      config: decodeSettings({
        enabled: options.enabled,
        setupMode: "managed",
        binaryPath: executable.executablePath,
        homePath,
        launchArgs: managedCodexLaunchArgs(invocation.command, authArgs),
      }),
      environment,
      revision: profileKey,
      sandboxBinds: {
        socketPaths: [endpoint],
        providerProfileDirs:
          homeLayout.sharedHomePath !== homePath ? [homeLayout.sharedHomePath] : [],
        helperPaths,
        extraRoBinds,
      },
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});

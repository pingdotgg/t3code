import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { codexChatGptProfileKey, makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { makeCodexManagedTokenSource } from "./CodexManagedTokenSource.ts";
import { codexManagedTokenCommandName } from "./codexManagedTokenCommand.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
const managedCodexLaunchArgs = (
  profileKey: string,
  command: string,
  args: ReadonlyArray<string>,
) => {
  const providerKey = `openai_token_sharing_${profileKey}`;
  return [
    `model_provider=${JSON.stringify(providerKey)}`,
    // Use a profile-specific inline table so recursive config merging cannot
    // inherit env_key/auth settings from a user's openai_token_sharing entry.
    `model_providers.${providerKey}={name="OpenAI Token Sharing",base_url="https://api.openai.com/v1",model_catalog_url="https://api.openai.com/v1/models",wire_api="responses",requires_openai_auth=false,supports_websockets=false,auth={command=${JSON.stringify(command)},args=${JSON.stringify(args)},timeout_ms=80000,refresh_interval_ms=0}}`,
    "features.api_key_model_discovery=true",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");
};

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
  const invocation = yield* resolveSelfInvocation();
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
  const resolveForProfile = (expectedProfileKey?: string) =>
    Effect.gen(function* () {
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
      // Finish local runtime preparation before touching refreshable OAuth state.
      const credentials =
        expectedProfileKey === undefined
          ? yield* auth.access
          : yield* auth.accessForProfile(expectedProfileKey);
      const profileKey = codexChatGptProfileKey(credentials);
      const source = yield* makeCodexManagedTokenSource(
        options.instanceId,
        credentials,
        auth.accessForProfile(profileKey),
      );
      const authArgs = selfInvocationArgs(invocation, [
        codexManagedTokenCommandName,
        source.endpoint,
      ]);
      // Ambient CLI overrides cannot redirect a T3-owned token to a different provider.
      // The auth command receives only a private local IPC endpoint, never a token or capability.
      const environment: NodeJS.ProcessEnv = {
        ...options.environment,
        CODEX_HOME: homePath,
      };
      delete environment.ACCESS_TOKEN;
      delete environment.T3CODE_CODEX_LAUNCH_ARGS;
      delete environment.OPENAI_API_KEY;
      delete environment.OPENAI_BASE_URL;
      return {
        config: decodeSettings({
          enabled: options.enabled,
          setupMode: "managed",
          binaryPath: executable.executablePath,
          homePath,
          launchArgs: managedCodexLaunchArgs(source.profileKey, invocation.command, authArgs),
        }),
        environment,
        revision: source.profileKey,
      } satisfies CodexEffectiveRuntime;
    });
  const resolve = resolveForProfile();
  return { auth, resolve, resolveForProfile, installation, homePath, homeLayout };
});

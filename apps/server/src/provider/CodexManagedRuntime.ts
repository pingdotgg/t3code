import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
const managedCodexLaunchArgs = (baseUrl: string) =>
  [
    'model_provider="openai_token_sharing"',
    // Codex persists this provider ID in rollouts and needs it unchanged to resume.
    // Codex retries terminal HTTP 401s as stream failures; the bridge owns the one auth retry.
    `model_providers.openai_token_sharing={name="OpenAI Token Sharing",base_url=${JSON.stringify(baseUrl)},model_catalog_url=${JSON.stringify(`${baseUrl}/models`)},wire_api="responses",requires_openai_auth=false,supports_websockets=false,stream_max_retries=0,env_key="T3_CODEX_MANAGED_TOKEN"}`,
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
    // Establish the HTTP boundary before auth.access can consume a refresh token.
    const responses = yield* broker.responses.pipe(
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
    const token = yield* responses.register({ instanceId: options.instanceId, profileKey });
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
      T3_CODEX_MANAGED_TOKEN: token,
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
        launchArgs: managedCodexLaunchArgs(responses.baseUrl),
      }),
      environment,
      revision: profileKey,
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});

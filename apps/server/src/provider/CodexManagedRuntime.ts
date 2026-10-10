import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import {
  makeCodexManagedTokenSource,
  managedCodexTokenCommand,
} from "./CodexManagedTokenSource.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
// Managed sign-in stores tokens in T3's credential store and never writes native auth.json.
const managedCodexLaunchArgs = [
  'model_provider="openai_token_sharing"',
  'model_providers.openai_token_sharing.name="OpenAI Token Sharing"',
  'model_providers.openai_token_sharing.base_url="https://api.openai.com/v1"',
  'model_providers.openai_token_sharing.model_catalog_url="https://api.openai.com/v1/models"',
  "features.api_key_model_discovery=true",
  `model_providers.openai_token_sharing.auth.command=${JSON.stringify(process.execPath)}`,
  `model_providers.openai_token_sharing.auth.args=${JSON.stringify(["-e", managedCodexTokenCommand])}`,
  "model_providers.openai_token_sharing.auth.timeout_ms=25000",
  "model_providers.openai_token_sharing.auth.refresh_interval_ms=30000",
  'model_providers.openai_token_sharing.wire_api="responses"',
  "model_providers.openai_token_sharing.requires_openai_auth=false",
  "model_providers.openai_token_sharing.supports_websockets=false",
]
  .map((value) => `-c '${value.replaceAll("'", "'\"'\"'")}'`)
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
  const auth = yield* makeCodexChatGptAuth({
    instanceId: options.instanceId,
    defaultReturnUrl: new URL(
      "/welcome",
      config.devUrl ?? `http://localhost:${config.port}`,
    ).toString(),
  });
  const scope = yield* Scope.Scope;
  const tokenSource = yield* makeCodexManagedTokenSource(options.instanceId, auth.access).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.cached,
  );
  const homeLayout = yield* resolveManagedCodexHomeLayout(
    config.stateDir,
    options.instanceId,
    options.config,
  );
  const homePath = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
  const resolve = Effect.gen(function* () {
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
    const source = yield* tokenSource;
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
      T3CODE_MANAGED_CODEX_AUTH_URL: source.url,
      T3CODE_MANAGED_CODEX_AUTH_SECRET: source.secret,
      T3CODE_MANAGED_CODEX_AUTH_ACCOUNT: credentials.clientId,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
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
        launchArgs: managedCodexLaunchArgs,
      }),
      environment,
      revision: credentials.accessToken,
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});

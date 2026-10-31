import {
  providerProxyApiUrl,
  providerProxyToken,
  type ProviderProxyRoute,
} from "@t3tools/provider-core/server/providerProxy";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

// Codex stores this ID in each rollout and resumes through it; renaming it strands proxied threads.
export const CODEX_PROXY_MODEL_PROVIDER = "t3_proxy";
const CODEX_PROXY_KEY_ENV = "T3_PROXY_KEY";

/** Appends the proxy provider after any configured launch arguments; the key stays out of argv. */
export const applyCodexProxyRuntime = <Config extends { readonly launchArgs: string }>(
  config: Config,
  environment: NodeJS.ProcessEnv,
  proxy: ProviderProxyRoute | undefined,
): { readonly config: Config; readonly environment: NodeJS.ProcessEnv } => {
  if (proxy === undefined) return { config, environment };
  const proxyArgs = [
    `model_provider="${CODEX_PROXY_MODEL_PROVIDER}"`,
    `model_providers.${CODEX_PROXY_MODEL_PROVIDER}={name="T3 proxy",base_url=${JSON.stringify(providerProxyApiUrl(proxy))},env_key="${CODEX_PROXY_KEY_ENV}",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");
  const launchArgs = resolveCodexLaunchArgs(config.launchArgs, environment);
  const next: NodeJS.ProcessEnv = {
    ...environment,
    [CODEX_PROXY_KEY_ENV]: providerProxyToken(proxy),
  };
  // Folded into launchArgs above; left in place it would replace the proxy arguments.
  delete next[T3CODE_CODEX_LAUNCH_ARGS_ENV];
  return {
    config: { ...config, launchArgs: launchArgs === "" ? proxyArgs : `${launchArgs} ${proxyArgs}` },
    environment: next,
  };
};

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

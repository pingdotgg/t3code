import {
  ClaudeSettings,
  CodexSettings,
  type ExecutionEnvironmentPlatformOs,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const SAFE_SHELL_BINARY_PATTERN = /^[A-Za-z0-9_./:\\-]+$/;

function quoteProviderBinary(
  binaryPath: string,
  fallback: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  if (
    SAFE_SHELL_BINARY_PATTERN.test(binaryPath) &&
    (platform === "windows" || !binaryPath.includes("\\"))
  ) {
    return binaryPath;
  }
  if (platform === "windows") return `& '${binaryPath.replaceAll("'", "''")}'`;
  if (platform === "darwin" || platform === "linux") {
    if (binaryPath.startsWith("~/") || binaryPath.startsWith("~\\")) {
      return `~/'${binaryPath.slice(2).replaceAll("'", `'"'"'`)}'`;
    }
    return `'${binaryPath.replaceAll("'", `'"'"'`)}'`;
  }
  return fallback;
}

export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

const PROVIDER_STATE_PRIORITY = {
  checking: 0,
  disabled: 1,
  install: 2,
  attention: 3,
  signIn: 4,
  ready: 5,
} as const;

/** Select the most usable configured instance for each provider driver. */
export function selectOnboardingProvidersByDriver(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
) {
  const providersByDriver = new Map<string, ServerProvider>();

  for (const provider of providers ?? []) {
    const existing = providersByDriver.get(provider.driver);
    if (
      existing === undefined ||
      PROVIDER_STATE_PRIORITY[getOnboardingProviderState(provider)] >
        PROVIDER_STATE_PRIORITY[getOnboardingProviderState(existing)]
    ) {
      providersByDriver.set(provider.driver, provider);
    }
  }

  return providersByDriver;
}

/**
 * Official standalone installers. Neither needs Node or npm, and both land in
 * the paths the server's provider maintenance recognizes as native, so the
 * one-click updater in Settings keeps working after install.
 */
const NATIVE_INSTALL_COMMANDS = {
  claudeAgent: {
    windows: "irm https://claude.ai/install.ps1 | iex",
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: {
    windows: "irm https://chatgpt.com/codex/install.ps1 | iex",
    posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
} as const;

/**
 * Install command for the setup terminal, keyed on the environment's platform
 * (not the client's): a Windows desktop driving a WSL server gets the shell
 * script. Unknown platforms get the shell script too, since the terminal there
 * is a POSIX shell in practice.
 */
export function resolveOnboardingProviderInstallCommand(
  driver: keyof typeof NATIVE_INSTALL_COMMANDS,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const commands = NATIVE_INSTALL_COMMANDS[driver];
  return platform === "windows" ? commands.windows : commands.posix;
}

/** Use the selected provider instance's binary when the setup terminal opens its login flow. */
export function resolveOnboardingProviderLoginCommand(
  provider: ServerProvider,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const instance = settings.providerInstances[provider.instanceId];

  if (provider.driver === "claudeAgent") {
    const config = decodeClaudeSettings(
      instance ? (instance.config ?? {}) : settings.providers.claudeAgent,
    );
    const binaryPath = Option.isSome(config) ? config.value.binaryPath : "claude";
    return `${quoteProviderBinary(binaryPath, "claude", platform)} auth login`;
  }

  if (provider.driver === "codex") {
    const config = decodeCodexSettings(
      instance ? (instance.config ?? {}) : settings.providers.codex,
    );
    const binaryPath = Option.isSome(config) ? config.value.binaryPath : "codex";
    return `${quoteProviderBinary(binaryPath, "codex", platform)} login`;
  }

  return provider.driver;
}

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_HEADROOM_PROXY_URL,
  normalizeHeadroomProxyUrl,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeSettingsUnsafe = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettingsUnsafe = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeRoutingSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      env: Schema.optionalKey(
        Schema.Struct({
          ANTHROPIC_BASE_URL: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);

type HeadroomRoutableProvider = "claudeAgent" | "codex";

interface ProviderRoutingConfig {
  readonly config: unknown;
  readonly environment: NodeJS.ProcessEnv;
}

export interface HeadroomSessionRoutingInput {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly settings: Pick<ServerSettings, "headroomProxyUrl" | "providerInstances" | "cpa">;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface HeadroomSessionRouting {
  readonly environment: Readonly<Record<string, string>>;
  /** Claude flag settings outrank a base URL in the user's settings file; the process env does not. */
  readonly claudeBaseUrl?: string;
  /** Codex routes per thread through these config overrides. */
  readonly codexConfig?: Readonly<Record<string, string>>;
}

function isHeadroomRoutableProvider(
  provider: ProviderDriverKind,
): provider is ProviderDriverKind & HeadroomRoutableProvider {
  return provider === "claudeAgent" || provider === "codex";
}

export function isHeadroomProxyUrl(
  value: string | undefined,
  provider: HeadroomRoutableProvider,
  configuredProxyUrl: string = DEFAULT_HEADROOM_PROXY_URL,
): boolean {
  if (value === undefined) return false;
  const configuredOrigin = normalizeHeadroomProxyUrl(configuredProxyUrl);
  if (configuredOrigin === null) return false;
  try {
    const url = new URL(value.trim());
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    return (
      url.origin === configuredOrigin &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (provider === "claudeAgent" ? pathname === "/" : pathname === "/v1")
    );
  } catch {
    return false;
  }
}

export function claudeSettingsRouteThroughHeadroom(
  contents: string,
  configuredProxyUrl: string = DEFAULT_HEADROOM_PROXY_URL,
): boolean {
  const decoded = decodeClaudeRoutingSettings(contents);
  return (
    Option.isSome(decoded) &&
    isHeadroomProxyUrl(decoded.value.env?.ANTHROPIC_BASE_URL, "claudeAgent", configuredProxyUrl)
  );
}

function stringAssignment(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(["'])([^"']*)\\1\\s*(?:#.*)?$`).exec(line);
  return match?.[2];
}

export interface CodexHeadroomRoutingConfig {
  readonly modelProvider: string | undefined;
  readonly openAiBaseUrl: string | undefined;
  readonly headroomBaseUrl: string | undefined;
  readonly cpaBaseUrl: string | undefined;
}

/** True when `value` points at the CLIProxyAPI origin, with Codex's `/v1` suffix where expected. */
export function isCpaUrl(
  value: string | undefined,
  provider: HeadroomRoutableProvider,
  cpaUrl: string,
): boolean {
  return isHeadroomProxyUrl(value, provider, cpaUrl);
}

export function inspectCodexHeadroomRouting(contents: string): CodexHeadroomRoutingConfig {
  let section = "";
  let modelProvider: string | undefined;
  let openAiBaseUrl: string | undefined;
  let headroomBaseUrl: string | undefined;
  let cpaBaseUrl: string | undefined;

  for (const line of contents.split(/\r?\n/)) {
    const table = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (table !== null) {
      section = table[1]?.trim() ?? "";
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    if (section === "") {
      modelProvider = stringAssignment(line, "model_provider") ?? modelProvider;
      openAiBaseUrl = stringAssignment(line, "openai_base_url") ?? openAiBaseUrl;
    } else if (section === "model_providers.headroom") {
      headroomBaseUrl = stringAssignment(line, "base_url") ?? headroomBaseUrl;
    } else if (section === "model_providers.cpa") {
      cpaBaseUrl = stringAssignment(line, "base_url") ?? cpaBaseUrl;
    }
  }

  return { modelProvider, openAiBaseUrl, headroomBaseUrl, cpaBaseUrl };
}

const resolveProviderRoutingConfig = Effect.fn(function* (input: {
  readonly provider: HeadroomRoutableProvider;
  readonly providerInstanceId: ProviderInstanceId;
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<ProviderRoutingConfig | undefined> {
  const explicit = input.settings.providerInstances[input.providerInstanceId];
  if (explicit !== undefined) {
    return {
      config: explicit.config ?? {},
      environment: yield* mergeProviderInstanceEnvironment(
        explicit.environment,
        input.environment ?? process.env,
      ),
    };
  }
  if (String(input.providerInstanceId) !== input.provider) return undefined;
  return {
    config: {},
    environment: input.environment ?? process.env,
  };
});

function environmentHomePath(
  path: Path.Path,
  value: string | undefined,
  cwd: string | undefined,
): string | undefined {
  const homePath = value?.trim() ?? "";
  if (homePath.length === 0) return undefined;
  return cwd === undefined ? path.resolve(homePath) : path.resolve(cwd, homePath);
}

const readOptional = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(Effect.option);

const claudeConfigDir = Effect.fn("HeadroomRouting.claudeConfigDir")(function* (
  config: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
) {
  const path = yield* Path.Path;
  const configuredHome = config.homePath.trim();
  return configuredHome.length > 0
    ? path.resolve(expandHomePath(configuredHome, yield* HostProcess.HomeDirectory))
    : (environmentHomePath(path, environment.CLAUDE_CONFIG_DIR, cwd) ??
        path.join(yield* HostProcess.HomeDirectory, ".claude"));
});

const codexConfigDir = Effect.fn("HeadroomRouting.codexConfigDir")(function* (
  config: CodexSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
) {
  const path = yield* Path.Path;
  const layout = yield* resolveCodexHomeLayout(config);
  return (
    layout.effectiveHomePath ??
    environmentHomePath(path, environment.CODEX_HOME, cwd) ??
    layout.sharedHomePath
  );
});

/** The Claude `settings.json` and Codex `config.toml` the default provider instances read. */
export const resolveDefaultCliConfigFiles = Effect.fn(
  "HeadroomRouting.resolveDefaultCliConfigFiles",
)(function* (settings: Pick<ServerSettings, "providerInstances">) {
  const path = yield* Path.Path;
  const instance = (provider: HeadroomRoutableProvider) =>
    resolveProviderRoutingConfig({
      provider,
      providerInstanceId: ProviderInstanceId.make(provider),
      settings,
    });
  const claude = yield* instance("claudeAgent");
  const codex = yield* instance("codex");
  const claudeConfig = decodeClaudeSettings(claude?.config ?? {});
  const codexConfig = decodeCodexSettings(codex?.config ?? {});
  const claudeDir = yield* claudeConfigDir(
    Option.getOrElse(claudeConfig, () => decodeClaudeSettingsUnsafe({})),
    claude?.environment ?? process.env,
    undefined,
  );
  const codexDir = yield* codexConfigDir(
    Option.getOrElse(codexConfig, () => decodeCodexSettingsUnsafe({})),
    codex?.environment ?? process.env,
    undefined,
  );
  return {
    claudeSettingsPath: path.join(claudeDir, "settings.json"),
    codexConfigPath: path.join(codexDir, "config.toml"),
  };
});

const codexLaunchOverride = (launchArgs: string, key: string): string | undefined => {
  const args = tokenizeCliArgs(launchArgs);
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const override =
      argument?.startsWith("--config=") === true || argument?.startsWith("-c=") === true
        ? argument.slice(argument.indexOf("=") + 1)
        : argument === "--config" || argument === "-c"
          ? args[++index]
          : undefined;
    if (override === undefined) continue;
    const separator = override.indexOf("=");
    if (separator === -1 || override.slice(0, separator).trim() !== key) continue;
    value = override
      .slice(separator + 1)
      .trim()
      .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  }
  return value;
};

const selectsCodexProfile = (launchArgs: string): boolean =>
  tokenizeCliArgs(launchArgs).some(
    (argument) =>
      argument === "--profile" || argument === "-p" || argument.startsWith("--profile="),
  );

function inspectCodexDefaultProfile(contents: string): string | undefined {
  let section = "";
  let profile: string | undefined;
  const profileProviders = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const table = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (table !== null) {
      section = table[1]?.trim() ?? "";
      continue;
    }
    if (section === "") {
      profile = stringAssignment(line, "profile") ?? profile;
      continue;
    }
    const profileSection = /^profiles\.([A-Za-z0-9_-]+)$/.exec(section);
    const provider = stringAssignment(line, "model_provider");
    if (profileSection?.[1] !== undefined && provider !== undefined) {
      profileProviders.set(profileSection[1], provider);
    }
  }
  return profile === undefined ? undefined : profileProviders.get(profile);
}

const headroomEnvironment = (proxyUrl: string): Readonly<Record<string, string>> => ({
  HEADROOM_ACTIVE: "1",
  HEADROOM_PROXY_URL: proxyUrl,
});

export interface ProviderHeadroomSessionRoutingInput {
  readonly provider: HeadroomRoutableProvider;
  readonly proxyUrl: string;
  /** When set, a CLI config that routes to this CLIProxyAPI chains through Headroom instead of bailing. */
  readonly cpaUrl?: string;
  readonly config: unknown;
  readonly cwd?: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Resolve one adapter's process-local route without changing persistent provider config. */
export const resolveProviderHeadroomSessionRouting = Effect.fn(
  "HeadroomRouting.resolveProviderSession",
)(function* (
  input: ProviderHeadroomSessionRoutingInput,
): Effect.fn.Return<HeadroomSessionRouting | undefined, never, FileSystem.FileSystem | Path.Path> {
  const proxyUrl = normalizeHeadroomProxyUrl(input.proxyUrl);
  if (proxyUrl === null) return undefined;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.provider === "claudeAgent") {
    const config = decodeClaudeSettings(input.config);
    if (Option.isNone(config)) return undefined;
    if (
      input.environment.CLAUDE_CODE_USE_BEDROCK ||
      input.environment.CLAUDE_CODE_USE_VERTEX ||
      input.environment.CLAUDE_CODE_USE_FOUNDRY
    ) {
      return undefined;
    }
    const configDir = yield* claudeConfigDir(config.value, input.environment, input.cwd);
    const contents = yield* readOptional(fileSystem, path.join(configDir, "settings.json"));
    const settingsRoute = Option.flatMap(contents, decodeClaudeRoutingSettings);
    const explicitBaseUrl =
      input.environment.ANTHROPIC_BASE_URL ??
      (Option.isSome(settingsRoute) ? settingsRoute.value.env?.ANTHROPIC_BASE_URL : undefined);
    if (input.cpaUrl !== undefined && isCpaUrl(explicitBaseUrl, "claudeAgent", input.cpaUrl)) {
      return {
        environment: { ...headroomEnvironment(proxyUrl), ANTHROPIC_BASE_URL: proxyUrl },
        claudeBaseUrl: proxyUrl,
      };
    }
    if (
      explicitBaseUrl !== undefined &&
      !isHeadroomProxyUrl(explicitBaseUrl, "claudeAgent", proxyUrl)
    ) {
      return undefined;
    }
    return {
      environment: {
        ...headroomEnvironment(proxyUrl),
        ANTHROPIC_BASE_URL: proxyUrl,
      },
    };
  }

  const config = decodeCodexSettings(input.config);
  if (Option.isNone(config)) return undefined;
  const launchArgs =
    input.environment.T3CODE_CODEX_LAUNCH_ARGS?.trim() || config.value.launchArgs.trim();
  if (selectsCodexProfile(launchArgs)) return undefined;
  const configDir = yield* codexConfigDir(config.value, input.environment, input.cwd);
  const contents = yield* readOptional(fileSystem, path.join(configDir, "config.toml"));
  const configContents = Option.getOrElse(contents, () => "");
  const inspected = inspectCodexHeadroomRouting(configContents);
  const modelProvider =
    codexLaunchOverride(launchArgs, "model_provider") ??
    inspectCodexDefaultProfile(configContents) ??
    inspected.modelProvider ??
    "openai";

  if (modelProvider === "headroom") {
    const overriddenBaseUrl = codexLaunchOverride(launchArgs, "model_providers.headroom.base_url");
    return isHeadroomProxyUrl(overriddenBaseUrl ?? inspected.headroomBaseUrl, "codex", proxyUrl)
      ? { environment: headroomEnvironment(proxyUrl) }
      : undefined;
  }
  if (modelProvider === "cpa") {
    const baseUrl =
      codexLaunchOverride(launchArgs, "model_providers.cpa.base_url") ?? inspected.cpaBaseUrl;
    return input.cpaUrl !== undefined && isCpaUrl(baseUrl, "codex", input.cpaUrl)
      ? {
          environment: headroomEnvironment(proxyUrl),
          codexConfig: { "model_providers.cpa.base_url": `${proxyUrl}/v1` },
        }
      : undefined;
  }
  if (modelProvider !== "openai") return undefined;

  const explicitBaseUrls = [
    input.environment.OPENAI_BASE_URL,
    codexLaunchOverride(launchArgs, "openai_base_url"),
    inspected.openAiBaseUrl,
  ].filter((value): value is string => value !== undefined);
  if (explicitBaseUrls.some((value) => !isHeadroomProxyUrl(value, "codex", proxyUrl))) {
    return undefined;
  }
  const baseUrl = `${proxyUrl}/v1`;
  return {
    environment: {
      ...headroomEnvironment(proxyUrl),
      OPENAI_BASE_URL: baseUrl,
    },
    codexConfig: { openai_base_url: baseUrl },
  };
});

/** Build process-local launch settings from the persisted provider-instance settings. */
export const resolveHeadroomSessionRouting = Effect.fn("HeadroomRouting.resolveSession")(function* (
  input: HeadroomSessionRoutingInput,
): Effect.fn.Return<HeadroomSessionRouting | undefined, never, FileSystem.FileSystem | Path.Path> {
  if (!isHeadroomRoutableProvider(input.provider)) return undefined;
  const resolved = yield* resolveProviderRoutingConfig({ ...input, provider: input.provider });
  if (resolved === undefined) return undefined;
  return yield* resolveProviderHeadroomSessionRouting({
    provider: input.provider,
    proxyUrl: input.settings.headroomProxyUrl,
    cpaUrl: input.settings.cpa.url,
    config: resolved.config,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    environment: resolved.environment,
  });
});

/** Headroom's generic session marker for adapters that route inside their own launcher. */
export function resolveHeadroomEnvironment(
  configuredProxyUrl: string,
): Readonly<Record<string, string>> | undefined {
  const proxyUrl = normalizeHeadroomProxyUrl(configuredProxyUrl);
  return proxyUrl === null ? undefined : headroomEnvironment(proxyUrl);
}

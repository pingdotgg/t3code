// @effect-diagnostics nodeBuiltinImport:off
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type GetAuthStatusResponse,
  type GetStatusResponse,
  type ModelInfo,
} from "@github/copilot-sdk";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CopilotSettings,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveCommandPath } from "@t3tools/shared/shell";

import { providerModelsFromSettings } from "./providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("copilot");

export const EMPTY_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const COPILOT_REASONING_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
} as const;

const GENERIC_EFFECT_TRY_PROMISE_MESSAGES = new Set([
  "An error occurred in Effect.tryPromise",
  "An error occurred in Effect.try",
]);
const COPILOT_CLI_PATH_ENV = "COPILOT_CLI_PATH";
const COPILOT_CLI_COMMAND = "copilot";
const COPILOT_FEATURE_FLAGS_ENV = "COPILOT_FEATURE_FLAGS";
const COPILOT_SHELL_SPAWN_BACKEND_FLAG = "SHELL_SPAWN_BACKEND";
const COPILOT_SHELL_SPAWN_BACKEND_EXP_ENV = "COPILOT_EXP_COPILOT_CLI_SHELL_SPAWN_BACKEND";
const COPILOT_POSIX_SHELL_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/bin/sh"] as const;

export class CopilotProbePromiseError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.name = "CopilotProbePromiseError";
  }
}

export function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function toCopilotProbeError(cause: unknown): CopilotProbePromiseError {
  return new CopilotProbePromiseError(cause);
}

function describeCopilotProbeCause(cause: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = cause;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const message = current.message.trim();
    if (message.length > 0 && !GENERIC_EFFECT_TRY_PROMISE_MESSAGES.has(message)) {
      return message;
    }
    current = current.cause;
  }

  if (typeof current === "string") {
    return current.trim();
  }

  return "";
}

function authTypeLabel(authType: GetAuthStatusResponse["authType"]): string | undefined {
  switch (authType) {
    case "user":
      return undefined;
    case "env":
      return "Environment token";
    case "gh-cli":
      return "GitHub CLI";
    case "hmac":
      return "HMAC key";
    case "api-key":
      return "API key";
    case "token":
      return "Bearer token";
    default:
      return undefined;
  }
}

function normalizeAuthLabelPart(value: string | null | undefined): string | undefined {
  const trimmed = trimOrUndefined(value);
  return trimmed ? trimmed.replace(/^@/, "").toLowerCase() : undefined;
}

export function createCopilotClient(input: {
  readonly settings: CopilotSettings;
  readonly cwd?: string;
  readonly baseDirectory?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logLevel?: CopilotClientOptions["logLevel"];
  readonly onListModels?: CopilotClientOptions["onListModels"];
}) {
  return new CopilotClient(buildCopilotClientOptions(input));
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }

    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isValidPosixShellPath(path: string | undefined): path is string {
  return !!path && !/\s/.test(path) && isAbsolute(path) && isExecutableFile(path);
}

function resolvePosixShellPath(currentShell: string | undefined): string | undefined {
  if (isValidPosixShellPath(currentShell)) {
    return currentShell;
  }

  return COPILOT_POSIX_SHELL_CANDIDATES.find(isExecutableFile);
}

function appendCommaSeparatedValue(value: string | undefined, entry: string): string {
  const entries =
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0) ?? [];

  return entries.includes(entry) ? entries.join(",") : [...entries, entry].join(",");
}

export function normalizeCopilotRuntimeEnvironment(
  input: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const env = { ...input };

  if (platform !== "win32") {
    const shellPath = resolvePosixShellPath(env.SHELL);
    if (shellPath) {
      env.SHELL = shellPath;
    }

    env[COPILOT_FEATURE_FLAGS_ENV] = appendCommaSeparatedValue(
      env[COPILOT_FEATURE_FLAGS_ENV],
      COPILOT_SHELL_SPAWN_BACKEND_FLAG,
    );
    env[COPILOT_SHELL_SPAWN_BACKEND_EXP_ENV] = "true";
  }

  return env;
}

function validateConfiguredCopilotCliPath(input: {
  readonly settings: CopilotSettings;
  readonly env?: Record<string, string | undefined>;
}): string | undefined {
  const cliUrl = trimOrUndefined(input.settings.serverUrl);
  if (cliUrl) {
    return undefined;
  }

  const cliPath = trimOrUndefined(input.settings.binaryPath);
  if (!cliPath) {
    return undefined;
  }

  const env = {
    ...process.env,
    ...input.env,
  };
  const resolvedCommandPath = resolveCommandPath(cliPath, { env });
  if (!resolvedCommandPath) {
    throw new Error(`The configured Copilot binary could not be found: ${cliPath}.`);
  }

  return resolvedCommandPath;
}

function candidateDirectoryAncestors(directory: string): ReadonlyArray<string> {
  const directories: string[] = [];
  let current = directory;

  for (let depth = 0; depth < 8; depth += 1) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories;
}

export function resolveBundledCopilotCliPath(input: {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}): string | undefined {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidateRoots = new Set<string>();

  if (input.cwd) {
    candidateRoots.add(input.cwd);
  }
  candidateRoots.add(process.cwd());

  for (const directory of candidateDirectoryAncestors(moduleDirectory)) {
    candidateRoots.add(directory);
  }

  for (const root of candidateRoots) {
    const candidate = join(root, "node_modules", ".bin", COPILOT_CLI_COMMAND);
    const resolved = resolveCommandPath(candidate, input.env ? { env: input.env } : {});
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

export function buildCopilotClientOptions(input: {
  readonly settings: CopilotSettings;
  readonly cwd?: string;
  readonly baseDirectory?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logLevel?: CopilotClientOptions["logLevel"];
  readonly onListModels?: CopilotClientOptions["onListModels"];
}): CopilotClientOptions {
  const cliUrl = trimOrUndefined(input.settings.serverUrl);
  let env: Record<string, string | undefined> = { ...process.env };

  if (input.env) {
    Object.assign(env, input.env);
  }

  delete env[COPILOT_CLI_PATH_ENV];
  env = normalizeCopilotRuntimeEnvironment(env);

  const configuredCliPath = validateConfiguredCopilotCliPath({
    settings: input.settings,
    env,
  });
  const bundledCliPath =
    !cliUrl && !configuredCliPath
      ? resolveBundledCopilotCliPath({ ...(input.cwd ? { cwd: input.cwd } : {}), env })
      : undefined;
  const cliPath = configuredCliPath ?? bundledCliPath;

  return {
    ...(cliUrl
      ? { connection: RuntimeConnection.forUri(cliUrl) }
      : cliPath
        ? { connection: RuntimeConnection.forStdio({ path: cliPath }) }
        : {}),
    mode: "copilot-cli",
    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
    ...(input.baseDirectory ? { baseDirectory: input.baseDirectory } : {}),
    env,
    ...(input.logLevel ? { logLevel: input.logLevel } : {}),
    ...(input.onListModels ? { onListModels: input.onListModels } : {}),
  };
}

export function versionFromCopilotStatus(status: GetStatusResponse): string | null {
  return trimOrUndefined(status.version) ?? null;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return tokens.toLocaleString("en-US");
}

function formatContextTierLabel(label: string, tokens: number | undefined): string {
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
    ? `${label} (${formatTokenCount(tokens)} tokens)`
    : label;
}

type CopilotModelInfoForCapabilities = Pick<ModelInfo, "capabilities"> & {
  readonly supportedReasoningEfforts?: ReadonlyArray<string>;
  readonly defaultReasoningEffort?: string;
  readonly billing?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPositiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function getCopilotContextTierTokenBudgets(model: CopilotModelInfoForCapabilities): {
  readonly defaultContextPromptTokens?: number;
  readonly longContextPromptTokens?: number;
} {
  if (!isRecord(model.billing)) {
    return {};
  }
  const tokenPrices = model.billing.tokenPrices;
  if (!isRecord(tokenPrices)) {
    return {};
  }
  const longContext = tokenPrices.longContext;
  const defaultContextPromptTokens = getPositiveFiniteNumber(tokenPrices.contextMax);
  const longContextPromptTokens = isRecord(longContext)
    ? getPositiveFiniteNumber(longContext.contextMax)
    : undefined;
  return {
    ...(defaultContextPromptTokens !== undefined ? { defaultContextPromptTokens } : {}),
    ...(longContextPromptTokens !== undefined ? { longContextPromptTokens } : {}),
  };
}

export function capabilitiesFromCopilotModel(
  model: CopilotModelInfoForCapabilities,
): ModelCapabilities {
  const reasoningOptions =
    model.supportedReasoningEfforts?.map((effort) => ({
      id: effort,
      label: COPILOT_REASONING_LABELS[effort] ?? effort,
      ...(model.defaultReasoningEffort === effort ? { isDefault: true } : {}),
    })) ?? [];
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const descriptors: Array<ProviderOptionDescriptor> = [];

  if (reasoningOptions.length > 0) {
    descriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }

  const contextTierTokenBudgets = getCopilotContextTierTokenBudgets(model);
  if (contextTierTokenBudgets.longContextPromptTokens !== undefined) {
    descriptors.push({
      id: "contextTier",
      label: "Context Window",
      type: "select",
      options: [
        {
          id: "default",
          label: formatContextTierLabel(
            "Default",
            contextTierTokenBudgets.defaultContextPromptTokens,
          ),
        },
        {
          id: "long_context",
          label: formatContextTierLabel(
            "Long Context",
            model.capabilities.limits.max_context_window_tokens,
          ),
        },
      ],
      currentValue: "default",
    });
  }

  return createModelCapabilities({ optionDescriptors: descriptors });
}

export function modelsFromCopilotSdk(input: {
  readonly models: ReadonlyArray<ModelInfo>;
  readonly customModels: ReadonlyArray<string>;
}): ReadonlyArray<ServerProviderModel> {
  const builtInModels = input.models.map((model) => ({
    slug: model.id.trim(),
    name: trimOrUndefined(model.name) ?? model.id.trim(),
    isCustom: false,
    capabilities: capabilitiesFromCopilotModel(model),
  })) satisfies ReadonlyArray<ServerProviderModel>;

  return providerModelsFromSettings(
    builtInModels,
    PROVIDER,
    input.customModels,
    EMPTY_COPILOT_MODEL_CAPABILITIES,
  );
}

export function authSnapshotFromCopilotSdk(authStatus: GetAuthStatusResponse): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
} {
  const authType = trimOrUndefined(authStatus.authType);
  const authTypeDisplay = authTypeLabel(authStatus.authType);
  const fallbackLabel = [
    authTypeDisplay,
    authStatus.login ? `@${authStatus.login}` : undefined,
    trimOrUndefined(authStatus.host)?.replace(/^https?:\/\//, ""),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" - ");
  const statusMessageLabel = trimOrUndefined(authStatus.statusMessage);
  const normalizedStatusMessage = normalizeAuthLabelPart(statusMessageLabel);
  const normalizedLogin = normalizeAuthLabelPart(authStatus.login);
  const normalizedAuthTypeDisplay = normalizeAuthLabelPart(authTypeDisplay);
  const label =
    authStatus.isAuthenticated &&
    normalizedStatusMessage !== undefined &&
    normalizedStatusMessage !== normalizedLogin &&
    normalizedStatusMessage !== normalizedAuthTypeDisplay
      ? statusMessageLabel
      : fallbackLabel;

  if (!authStatus.isAuthenticated) {
    return {
      status: "error",
      auth: {
        status: "unauthenticated",
        ...(authType ? { type: authType } : {}),
        ...(label ? { label } : {}),
      },
      message:
        trimOrUndefined(authStatus.statusMessage) ??
        "GitHub Copilot is not authenticated. Sign in with the Copilot CLI or provide a supported token.",
    };
  }

  return {
    status: "ready",
    auth: {
      status: "authenticated",
      ...(authType ? { type: authType } : {}),
      ...(label ? { label } : {}),
    },
  };
}

export function formatCopilotProbeError(input: {
  readonly cause: unknown;
  readonly settings: CopilotSettings;
}): {
  readonly installed: boolean;
  readonly message: string;
} {
  const message = describeCopilotProbeCause(input.cause);
  const lower = message.toLowerCase();
  const cliUrl = trimOrUndefined(input.settings.serverUrl);
  const cliPath = trimOrUndefined(input.settings.binaryPath);

  if (cliUrl) {
    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("network") ||
      lower.includes("timed out") ||
      lower.includes("timeout")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured Copilot server at ${cliUrl}. Check that it is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: message || "Failed to connect to the configured Copilot server.",
    };
  }

  if (
    lower.includes("enoent") ||
    lower.includes("spawn") ||
    lower.includes("not found") ||
    lower.includes("could not find") ||
    lower.includes("could not be found") ||
    lower.includes("not executable")
  ) {
    return {
      installed: false,
      message: cliPath
        ? `The configured Copilot binary could not be started: ${cliPath}.`
        : "The bundled GitHub Copilot CLI could not be started.",
    };
  }

  return {
    installed: true,
    message: message || "GitHub Copilot SDK probe failed.",
  };
}

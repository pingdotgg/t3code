import {
  CopilotClient,
  type CopilotClientOptions,
  type GetAuthStatusResponse,
  type GetStatusResponse,
  type ModelInfo,
} from "@github/copilot-sdk";
import type {
  CopilotSettings,
  ModelCapabilities,
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

const COPILOT_REASONING_LABELS = {
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
      return "Signed-in user";
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

export function createCopilotClient(input: {
  readonly settings: CopilotSettings;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logLevel?: CopilotClientOptions["logLevel"];
  readonly onListModels?: CopilotClientOptions["onListModels"];
}) {
  return new CopilotClient(buildCopilotClientOptions(input));
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
    ...(input.env ?? {}),
  };
  const resolvedCommandPath = resolveCommandPath(cliPath, { env });
  if (!resolvedCommandPath) {
    throw new Error(`The configured Copilot binary could not be found: ${cliPath}.`);
  }

  return resolvedCommandPath;
}

export function buildCopilotClientOptions(input: {
  readonly settings: CopilotSettings;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logLevel?: CopilotClientOptions["logLevel"];
  readonly onListModels?: CopilotClientOptions["onListModels"];
}): CopilotClientOptions {
  const cliPath = validateConfiguredCopilotCliPath({
    settings: input.settings,
    ...(input.env ? { env: input.env } : {}),
  });
  const cliUrl = trimOrUndefined(input.settings.serverUrl);
  const env = { ...process.env };

  if (input.env) {
    Object.assign(env, input.env);
  }

  delete env[COPILOT_CLI_PATH_ENV];

  return {
    ...(cliUrl ? { cliUrl } : {}),
    ...(!cliUrl && cliPath ? { cliPath } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env,
    ...(input.logLevel ? { logLevel: input.logLevel } : {}),
    ...(input.onListModels ? { onListModels: input.onListModels } : {}),
  };
}

export function versionFromCopilotStatus(status: GetStatusResponse): string | null {
  return trimOrUndefined(status.version) ?? null;
}

export function capabilitiesFromCopilotModel(
  model: Pick<ModelInfo, "supportedReasoningEfforts" | "defaultReasoningEffort">,
): ModelCapabilities {
  const reasoningOptions =
    model.supportedReasoningEfforts?.map((effort) => ({
      id: effort,
      label: COPILOT_REASONING_LABELS[effort as keyof typeof COPILOT_REASONING_LABELS] ?? effort,
      ...(model.defaultReasoningEffort === effort ? { isDefault: true } : {}),
    })) ?? [];
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;

  return createModelCapabilities({
    optionDescriptors:
      reasoningOptions.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              options: reasoningOptions,
              ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
            },
          ]
        : [],
  });
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
  const label = [
    authTypeLabel(authStatus.authType),
    authStatus.login ? `@${authStatus.login}` : undefined,
    trimOrUndefined(authStatus.host)?.replace(/^https?:\/\//, ""),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" - ");

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

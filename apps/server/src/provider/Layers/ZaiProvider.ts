/**
 * ZaiProvider — snapshot probing for the Z.ai driver.
 *
 * Z.ai rides the Claude Code CLI against Z.ai's Anthropic-compatible
 * endpoint, so "installed" means the Claude CLI is present and "authenticated"
 * means an API key reached the CLI via `ANTHROPIC_AUTH_TOKEN`. The version
 * probe and SDK capabilities probe are the Claude ones, run with the Z.ai
 * instance environment; presentation, model catalog, and auth labels are
 * Z.ai's own.
 *
 * @module provider/Layers/ZaiProvider
 */
import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ZaiSettings,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { claudeSettingsForZai, ZAI_AUTH_TOKEN_ENV_VAR } from "../Drivers/ZaiHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import {
  runClaudeCommand,
  type ClaudeCapabilitiesProbe,
} from "./ClaudeProvider.ts";

const ZAI_PRESENTATION = {
  displayName: "Z.ai",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * GLM model ids exactly as Z.ai's endpoint expects them. The 1M-context
 * variant is a distinct slug (`glm-5.2[1m]`, Z.ai's own convention) rather
 * than a context-window descriptor, because descriptor-driven `[1m]`
 * suffixing only resolves against the Claude model catalog.
 */
const ZAI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "glm-5.3",
    name: "GLM-5.3",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "glm-5.3[1m]",
    name: "GLM-5.3 1M",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "glm-5.2",
    name: "GLM-5.2",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "glm-5.2[1m]",
    name: "GLM-5.2 1M",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "glm-5-turbo",
    name: "GLM-5 Turbo",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "glm-4.7",
    name: "GLM-4.7",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function zaiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(ZAI_BUILT_IN_MODELS, customModels ?? [], EMPTY_CAPABILITIES);
}

function zaiAuthMetadata(
  authMethod: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return { type: "apiKey", label: "Z.ai API Key" };
  }
  return undefined;
}

export function buildInitialZaiProviderSnapshot(
  zaiSettings: Pick<ZaiSettings, "enabled" | "customModels">,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = zaiModelsFromSettings(zaiSettings.customModels);

    if (!zaiSettings.enabled) {
      return buildServerProvider({
        presentation: ZAI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Z.ai is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ZAI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Z.ai provider status has not been checked in this session yet.",
      },
    });
  });
}

export const checkZaiProviderStatus = Effect.fn("checkZaiProviderStatus")(function* (
  zaiSettings: ZaiSettings,
  resolveCapabilities?: () => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const claudeConfig = claudeSettingsForZai(zaiSettings);
  const models = zaiModelsFromSettings(zaiSettings.customModels);

  if (!zaiSettings.enabled) {
    return buildServerProvider({
      presentation: ZAI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Z.ai is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(claudeConfig, ["--version"], resolvedEnvironment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Z.ai provider health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: ZAI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Z.ai runs through the Claude Code CLI (`claude`), which is not installed or not on PATH."
          : "Failed to execute Claude Code CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: ZAI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Code CLI is installed but timed out while running `claude --version`.",
      },
    });
  }

  const versionOutput = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Claude Code CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: ZAI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Code CLI is installed but failed to run.",
      },
    });
  }

  const hasAuthToken =
    zaiSettings.apiKey.trim().length > 0 || Boolean(resolvedEnvironment[ZAI_AUTH_TOKEN_ENV_VAR]);
  if (!hasAuthToken) {
    return buildServerProvider({
      presentation: ZAI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Z.ai is not configured. Add your Z.ai API key in provider settings.",
      },
    });
  }

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities().pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const skills = yield* discoverClaudeSkills(claudeConfig, cwd, resolvedEnvironment);
  const slashCommands = capabilities?.slashCommands ?? [];

  if (!capabilities) {
    return buildServerProvider({
      presentation: ZAI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Z.ai authentication from the Claude Code CLI initialization result.",
      },
    });
  }

  const authMetadata = zaiAuthMetadata(capabilities.tokenSource);
  return buildServerProvider({
    presentation: ZAI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(authMetadata ? authMetadata : {}),
      },
    },
  });
});

export const enrichZaiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.asVoid,
  );
};

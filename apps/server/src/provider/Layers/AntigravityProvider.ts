import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Gemini",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

const ANTIGRAVITY_EFFORT_DESCRIPTOR = buildSelectOptionDescriptor({
  id: "effort",
  label: "Reasoning",
  options: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
  ],
});

const ANTIGRAVITY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [ANTIGRAVITY_EFFORT_DESCRIPTOR],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

const ANTIGRAVITY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    isCustom: false,
    capabilities: ANTIGRAVITY_CAPABILITIES,
  },
  {
    slug: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    isCustom: false,
    capabilities: ANTIGRAVITY_CAPABILITIES,
  },
  {
    slug: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    isCustom: false,
    capabilities: ANTIGRAVITY_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    isCustom: false,
    capabilities: ANTIGRAVITY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    isCustom: false,
    capabilities: ANTIGRAVITY_CAPABILITIES,
  },
  {
    slug: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    isCustom: false,
    capabilities: ANTIGRAVITY_CAPABILITIES,
  },
  {
    slug: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    isCustom: false,
    capabilities: ANTIGRAVITY_CAPABILITIES,
  },
];

export function parseAntigravityModels(output: string): ReadonlyArray<ServerProviderModel> {
  const lines = output.split("\n");
  const modelsMap = new Map<string, ServerProviderModel>();
  for (const line of lines) {
    const cleanLine = line.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s\w.]+Fetching available models\.\.\./, "").trim();
    if (!cleanLine) continue;
    const match =
      cleanLine.match(/^([a-z0-9_.-]+)\s{2,}(.+)$/i) || cleanLine.match(/^([a-z0-9_.-]+)\s+(.+)$/i);
    if (match && match[1] && match[2]) {
      const rawSlug = match[1].trim();
      const rawName = match[2].trim();
      const slug = rawSlug.replace(/-(low|medium|high)$/i, "");
      const name = rawName.replace(/\s*\((Low|Medium|High)\)$/i, "");
      if (!modelsMap.has(slug)) {
        modelsMap.set(slug, {
          slug,
          name,
          isCustom: false,
          capabilities: ANTIGRAVITY_CAPABILITIES,
        });
      }
    }
  }
  const result = Array.from(modelsMap.values());
  return result.length > 0 ? result : ANTIGRAVITY_BUILT_IN_MODELS;
}

function resolveAntigravityAccount(
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
): { readonly email?: string; readonly label?: string; readonly type?: string } {
  const email =
    settings.accountEmail?.trim() ||
    environment.ANTIGRAVITY_ACCOUNT_EMAIL ||
    environment.GOOGLE_ACCOUNT_EMAIL ||
    undefined;
  const label = settings.subscriptionLabel?.trim() || undefined;
  return {
    ...(email ? { email } : {}),
    ...(label ? { label } : {}),
    type: email ? "oauth" : "antigravity",
  };
}

export function buildInitialAntigravityProviderSnapshot(
  settings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = antigravityModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity CLI availability...",
      },
    });
  });
}

function antigravityModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ANTIGRAVITY_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], ANTIGRAVITY_CAPABILITIES);
}

const runAntigravityProbeCommand = (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--help"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const runAntigravityModelsCommand = (
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, ["models"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = antigravityModelsFromSettings(settings.customModels);
    const account = resolveAntigravityAccount(settings, environment);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    const probeResult = yield* runAntigravityProbeCommand(settings, environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(probeResult)) {
      const error = probeResult.failure;
      yield* Effect.logWarning("Antigravity CLI health check failed.", {
        errorTag: error._tag,
      });
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Antigravity CLI (`agy`) is not installed or not on PATH."
            : "Failed to execute Antigravity CLI health check.",
        },
      });
    }

    if (Option.isNone(probeResult.success)) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but timed out while running `agy --help`.",
        },
      });
    }

    const probeOutput = probeResult.success.value;
    const version = parseGenericCliVersion(`${probeOutput.stdout}\n${probeOutput.stderr}`);

    if (probeOutput.code !== 0) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Antigravity CLI is installed but exited with non-zero status.",
        },
      });
    }

    const modelsProbeResult = yield* runAntigravityModelsCommand(settings, environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    const discoveredModels =
      Result.isSuccess(modelsProbeResult) &&
      Option.isSome(modelsProbeResult.success) &&
      modelsProbeResult.success.value.code === 0
        ? parseAntigravityModels(
            `${modelsProbeResult.success.value.stdout}\n${modelsProbeResult.success.value.stderr}`,
          )
        : ANTIGRAVITY_BUILT_IN_MODELS;
    const finalModels = antigravityModelsFromSettings(settings.customModels, discoveredModels);

    const antigravityStatus: ServerProviderAntigravityStatus = {
      account: {
        email: account.email ?? null,
        type: account.type ?? "Google / Antigravity CLI",
        tier: account.label ?? "Standard",
      },
      cli: {
        binaryPath: settings.binaryPath || "agy",
        version: version ?? null,
        installed: true,
        status: "ready",
        modelsCount: finalModels.length,
      },
    };
    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: finalModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: account.email
          ? {
              status: "authenticated",
              ...account,
            }
          : { status: "unknown" },
      },
    });
  },
);

export const enrichAntigravitySnapshot = (input: {
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
    Effect.catchCause((cause) =>
      Effect.logWarning("Antigravity version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

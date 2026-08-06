import {
  type GrokSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
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
import { makeGrokAcpRuntime, resolveGrokAcpBaseModelId } from "../acp/GrokAcpSupport.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  // Plan/Build maps to Grok's `/plan` command on send (no ACP session modes).
  // Live 0.2.x: session/set_model works in-session; no forced new thread.
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/** Grok ACP handles `/compact` as prompt text; surface it in the composer slash menu. */
export const GROK_STATIC_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "compact",
    description: "Compress conversation history to reclaim context window",
    input: { hint: "optional context about what to preserve" },
  },
];

/** Ensure static commands (e.g. compact) remain present after live catalog merges. */
export function ensureGrokStaticSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  const existing = commands ?? [];
  const names = new Set(existing.map((command) => command.name.trim().toLowerCase()));
  const missing = GROK_STATIC_SLASH_COMMANDS.filter(
    (command) => !names.has(command.name.trim().toLowerCase()),
  );
  return missing.length === 0 ? existing : [...existing, ...missing];
}

function reasoningEffortLabels(value: string): string {
  const normalized = value.trim().toLowerCase();
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
  };
  return labels[normalized] ?? value;
}

/** Map Grok/ACP model `_meta.reasoningEfforts` into composer optionDescriptors when present. */
export function capabilitiesFromGrokModelMeta(
  meta: Record<string, unknown> | null | undefined,
): ModelCapabilities {
  if (!meta) {
    return EMPTY_CAPABILITIES;
  }
  const rawEfforts = meta.reasoningEfforts ?? meta.reasoning_efforts;
  if (!Array.isArray(rawEfforts) || rawEfforts.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  const defaultEffort =
    typeof meta.defaultReasoningEffort === "string"
      ? meta.defaultReasoningEffort.trim()
      : typeof meta.default_reasoning_effort === "string"
        ? meta.default_reasoning_effort.trim()
        : undefined;
  const options = rawEfforts.flatMap((entry) => {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (!id) return [];
      return [
        {
          id,
          label: reasoningEffortLabels(id),
          ...(defaultEffort === id ? { isDefault: true as const } : {}),
        },
      ];
    }
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id =
      typeof record.value === "string" && record.value.trim()
        ? record.value.trim()
        : typeof record.id === "string" && record.id.trim()
          ? record.id.trim()
          : "";
    if (!id) {
      return [];
    }
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : reasoningEffortLabels(id);
    const isDefault =
      record.default === true || defaultEffort === id || defaultEffort === record.id;
    return [
      {
        id,
        label,
        ...(isDefault ? { isDefault: true as const } : {}),
      },
    ];
  });
  if (options.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options,
      },
    ],
  });
}

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGrokProviderSnapshot(
  grokSettings: GrokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = grokModelsFromSettings(grokSettings.customModels);

    if (!grokSettings.enabled) {
      return buildServerProvider({
        presentation: GROK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        slashCommands: GROK_STATIC_SLASH_COMMANDS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      slashCommands: GROK_STATIC_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Grok CLI availability...",
      },
    });
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Validate untrusted `modelState` (e.g. initialize `_meta`) the same way
 * `isSessionModelState` does for ACP session payloads — reject null entries
 * and objects missing string `modelId`/`name` so discovery cannot throw.
 */
export function isGrokSessionModelState(
  value: unknown,
): value is EffectAcpSchema.SessionModelState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.availableModels)) {
    return false;
  }
  return record.availableModels.every(
    (model) =>
      model !== null &&
      typeof model === "object" &&
      !Array.isArray(model) &&
      typeof (model as { modelId?: unknown }).modelId === "string" &&
      typeof (model as { name?: unknown }).name === "string",
  );
}

function buildGrokDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (
    !modelState ||
    !Array.isArray(modelState.availableModels) ||
    modelState.availableModels.length === 0
  ) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      // Defensive: typed SessionModelState can still arrive malformed via casts.
      if (
        model === null ||
        typeof model !== "object" ||
        typeof (model as { modelId?: unknown }).modelId !== "string" ||
        typeof (model as { name?: unknown }).name !== "string"
      ) {
        return undefined;
      }
      const modelId = (model as { modelId: string; name: string; _meta?: unknown }).modelId;
      const name = (model as { modelId: string; name: string; _meta?: unknown }).name;
      const slug = resolveGrokAcpBaseModelId(modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      const rawMeta = (model as { _meta?: unknown })._meta;
      const meta =
        rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
          ? (rawMeta as Record<string, unknown>)
          : undefined;
      return {
        slug,
        name: name.trim() || slug,
        isCustom: false,
        capabilities: capabilitiesFromGrokModelMeta(meta),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export interface GrokAcpDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly authEmail?: string;
  readonly authLabel?: string;
}

export function mapAcpCommandsToCatalog(
  commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly inputHint?: string;
  }>,
): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];
  for (const command of commands) {
    const name = command.name.trim();
    if (!name) continue;
    const description = command.description?.trim();
    slashCommands.push({
      name,
      ...(description ? { description } : {}),
      ...(command.inputHint ? { input: { hint: command.inputHint } } : {}),
    });
    // Grok advertises skills as slash-style commands; mirror into skills when
    // description is present so the $ picker is non-empty (#4109 class).
    if (description) {
      skills.push({
        name,
        description,
        path: `acp://${name}`,
        enabled: true,
      });
    }
  }
  return { slashCommands, skills };
}

const discoverGrokModelsViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    // Prefer modelState from session setup; fall back to initialize _meta (live wire).
    const initializeMeta =
      started.initializeResult._meta &&
      typeof started.initializeResult._meta === "object" &&
      !Array.isArray(started.initializeResult._meta)
        ? (started.initializeResult._meta as Record<string, unknown>)
        : undefined;
    const modelsFromSession = buildGrokDiscoveredModelsFromSessionModelState(
      started.sessionSetupResult.models,
    );
    const rawInitializeModelState = initializeMeta?.modelState;
    // Require well-formed entries (string modelId/name); malformed arrays such as
    // `[null]` must fall through to built-in models instead of throwing.
    const initializeModelState = isGrokSessionModelState(rawInitializeModelState)
      ? rawInitializeModelState
      : undefined;
    const modelsFromInitialize =
      buildGrokDiscoveredModelsFromSessionModelState(initializeModelState);
    const models = modelsFromSession.length > 0 ? modelsFromSession : modelsFromInitialize;
    const initializeCommands = Array.isArray(initializeMeta?.availableCommands)
      ? (initializeMeta.availableCommands as ReadonlyArray<unknown>).flatMap((command) => {
          if (command === null || typeof command !== "object") {
            return [];
          }
          const entry = command as {
            readonly name?: unknown;
            readonly description?: unknown;
            readonly input?: unknown;
          };
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          if (!name) return [];
          const description =
            typeof entry.description === "string" ? entry.description.trim() : undefined;
          const inputHint =
            entry.input &&
            typeof entry.input === "object" &&
            entry.input !== null &&
            "hint" in entry.input &&
            typeof (entry.input as { hint: unknown }).hint === "string"
              ? (entry.input as { hint: string }).hint.trim()
              : undefined;
          return [
            {
              name,
              ...(description ? { description } : {}),
              ...(inputHint ? { inputHint } : {}),
            },
          ];
        })
      : [];
    const catalog = mapAcpCommandsToCatalog(initializeCommands);
    const authMeta =
      started.authenticateResult?._meta &&
      typeof started.authenticateResult._meta === "object" &&
      !Array.isArray(started.authenticateResult._meta)
        ? (started.authenticateResult._meta as Record<string, unknown>)
        : undefined;
    const authEmail =
      typeof authMeta?.email === "string" && authMeta.email.trim()
        ? authMeta.email.trim()
        : undefined;
    const authLabel =
      typeof authMeta?.subscription_tier === "string" && authMeta.subscription_tier.trim()
        ? `Grok ${authMeta.subscription_tier.trim()}`
        : typeof authMeta?.auth_mode === "string" && authMeta.auth_mode.trim()
          ? authMeta.auth_mode.trim()
          : undefined;
    return {
      models,
      slashCommands: ensureGrokStaticSlashCommands(catalog.slashCommands),
      skills: catalog.skills,
      ...(authEmail ? { authEmail } : {}),
      ...(authLabel ? { authLabel } : {}),
    } satisfies GrokAcpDiscoveryResult;
  }).pipe(Effect.scoped);

const runGrokVersionCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
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

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      slashCommands: GROK_STATIC_SLASH_COMMANDS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runGrokVersionCommand(grokSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Grok CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: GROK_STATIC_SLASH_COMMANDS,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : "Failed to execute Grok CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: GROK_STATIC_SLASH_COMMANDS,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but timed out while running `grok --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Grok CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: GROK_STATIC_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverGrokModelsViaAcp(grokSettings, environment).pipe(
    Effect.timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    const errorTag = causeErrorTag(discoveryExit.cause);
    yield* Effect.logWarning("Grok ACP model discovery failed", {
      errorTag,
    });
    const authFailure =
      /auth|unauth|login|token|credential|oidc|forbidden|unauthorized/i.test(errorTag) ||
      /auth|unauth|login|token|credential/i.test(String(discoveryExit.cause));
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: GROK_STATIC_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: authFailure ? "unauthenticated" : "unknown" },
        message: authFailure
          ? "Grok CLI is installed but authentication failed. Run `grok login` or set XAI_API_KEY."
          : "Grok CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Grok ACP model discovery timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      slashCommands: GROK_STATIC_SLASH_COMMANDS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Grok CLI is installed but ACP startup timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovery = discoveryExit.value.value;
  const models =
    discovery.models.length > 0
      ? grokModelsFromSettings(grokSettings.customModels, discovery.models)
      : fallbackModels;

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: grokSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      // Process-observed: authenticate + session start succeeded on this probe.
      auth: {
        status: "authenticated",
        ...(discovery.authLabel ? { label: discovery.authLabel } : {}),
        ...(discovery.authEmail ? { email: discovery.authEmail } : {}),
      },
    },
  });
});

export const enrichGrokSnapshot = (input: {
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
      Effect.logWarning("Grok version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

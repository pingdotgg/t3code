import type {
  HermesSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
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
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const HERMES_VERSION_PROBE_TIMEOUT_MS = 4_000;
const HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const HERMES_ACP_MODEL_DISCOVERY_FAILED_MESSAGE = [
  "Hermes ACP model discovery failed.",
  "Hermes may not be configured on this machine yet; run `hermes setup` (or `hermes acp --setup`), then retry.",
  "Check server logs for ACP details.",
].join(" ");

const HERMES_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Hermes (configured default)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getHermesFallbackModels(hermesSettings);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes Agent availability...",
      },
    });
  });
}

function buildHermesDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

export const discoverHermesModelsViaAcp = (
  hermesSettings: HermesSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings,
      ...(environment ? { environment } : {}),
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildHermesDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

export function getHermesFallbackModels(
  hermesSettings: Pick<HermesSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    HERMES_BUILT_IN_MODELS,
    hermesSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

/**
 * Extract the Hermes Agent version from `hermes --version` output.
 *
 * The first line looks like:
 * `Hermes Agent v0.21.0 (2026.8.31) · upstream f98f5e74`
 *
 * The generic parser would grab the parenthesised build date first, so we
 * prefer the `v`-prefixed semver token and fall back to the generic parser.
 */
export function parseHermesCliVersion(output: string): string | null {
  const match = output.match(/\bv(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? parseGenericCliVersion(output);
}

export interface HermesVersionResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts: Array<string> = [];
  for (const message of messages) {
    const trimmed = message?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildHermesCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Hermes Agent command \`${binaryPath}\` was not found.`,
    `Install the Hermes Agent CLI, make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
  ].join(" ");
}

export function buildHermesProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly hermesSettings: HermesSettings;
  readonly parsed: HermesVersionResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: input.hermesSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels && input.discoveredModels.length > 0
        ? input.discoveredModels
        : HERMES_BUILT_IN_MODELS,
      input.hermesSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

/** Interpret `hermes --version` output as a probe result. */
export function parseHermesVersionOutput(result: CommandResult): HermesVersionResult {
  const version = parseHermesCliVersion(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    return {
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes Agent CLI is installed but failed to run.",
    };
  }
  return { version, status: "ready", auth: { status: "unknown" } };
}

const runHermesVersionCommand = (hermesSettings: HermesSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      ["--version"],
      environment ? { env: environment } : {},
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(environment ? { env: environment } : { extendEnv: true }),
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getHermesFallbackModels(hermesSettings);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runHermesVersionCommand(hermesSettings, environment).pipe(
    Effect.timeoutOption(HERMES_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Hermes Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? buildHermesCliCommandMissingMessage(hermesSettings.binaryPath || "hermes")
          : "Failed to execute Hermes Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes Agent CLI is installed but timed out while running `hermes --version`.",
      },
    });
  }

  const parsed = parseHermesVersionOutput(versionProbe.success.value);
  // Hermes has no standalone auth probe: `hermes acp` authenticates through the
  // "custom" method during startup, so a successful ACP discovery doubles as
  // proof of authentication.
  let auth: ServerProviderAuth = parsed.auth;
  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveryWarning: string | undefined;
  if (parsed.status === "ready") {
    const discoveryExit = yield* Effect.exit(
      discoverHermesModelsViaAcp(hermesSettings, environment).pipe(
        Effect.timeoutOption(HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("Hermes ACP model discovery failed", {
        errorTag: causeErrorTag(discoveryExit.cause),
      });
      discoveryWarning = HERMES_ACP_MODEL_DISCOVERY_FAILED_MESSAGE;
    } else if (Option.isNone(discoveryExit.value)) {
      discoveryWarning = `Hermes ACP model discovery timed out after ${HERMES_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else if (discoveryExit.value.value.length === 0) {
      discoveryWarning = "Hermes ACP model discovery returned no built-in models.";
      auth = { status: "authenticated" };
    } else {
      discoveredModels = discoveryExit.value;
      auth = { status: "authenticated" };
    }
  }
  return buildHermesProviderSnapshot({
    checkedAt,
    hermesSettings,
    parsed: { ...parsed, auth },
    discoveredModels: Option.getOrElse(
      Option.filter(discoveredModels, (models) => models.length > 0),
      () => [] as const,
    ),
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});

/**
 * Background maintenance enrichment for a Hermes snapshot.
 *
 * Used by `HermesDriver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: republishes update/version advisory metadata without performing any
 * model or capability discovery. Hermes model data comes exclusively from ACP
 * session setup during provider status checks.
 */
export const enrichHermesSnapshot = (input: {
  readonly settings: HermesSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { settings, snapshot, publishSnapshot } = input;
  const stampIdentity = input.stampIdentity ?? ((value) => value);

  if (!settings.enabled || snapshot.auth.status === "unauthenticated") {
    return Effect.void;
  }

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) =>
      publishSnapshot(stampIdentity(enrichedSnapshot)).pipe(Effect.as(enrichedSnapshot)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};

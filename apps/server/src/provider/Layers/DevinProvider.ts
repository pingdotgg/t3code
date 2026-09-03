import type {
  DevinSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;
const DEVIN_CLI_INSTALLATION_DOCS_URL = "https://docs.devin.ai/cli";
const DEVIN_ACP_MODEL_DISCOVERY_FAILED_MESSAGE = [
  "Devin ACP model discovery failed.",
  "Devin CLI setup may be incomplete; install or enable the Devin CLI, restart T3 Code, and try again.",
  `See ${DEVIN_CLI_INSTALLATION_DOCS_URL}.`,
  "Check server logs for ACP details.",
].join(" ");

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getDevinFallbackModels(devinSettings);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

interface DevinAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
}

function buildDevinDiscoveredModels(
  discoveredModels: ReadonlyArray<DevinAcpDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) return [];
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: model.name || model.slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function flattenModelSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<DevinAcpDiscoveredModel> {
  if (!configOption || configOption.type !== "select") return [];
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ slug: entry.value.trim(), name: entry.name.trim() }]
      : entry.options.map((option) => ({
          slug: option.value.trim(),
          name: option.name.trim(),
        })),
  );
}

const makeDevinAcpProbeRuntime = (devinSettings: DevinSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: devinSettings.binaryPath,
          args: ["acp"],
          cwd: process.cwd(),
          ...(environment ? { env: environment } : {}),
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        authMethodId: "devin-browser",
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
      Effect.provideService(Crypto.Crypto, crypto),
    );
    return runtime;
  });

const withDevinAcpProbeRuntime = <A, E, R>(
  devinSettings: DevinSettings,
  useRuntime: (acp: AcpSessionRuntime.AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
  environment?: NodeJS.ProcessEnv,
) =>
  makeDevinAcpProbeRuntime(devinSettings, environment).pipe(
    Effect.flatMap(useRuntime),
    Effect.scoped,
  );

export const discoverDevinModelsViaAcp = (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  withDevinAcpProbeRuntime(
    devinSettings,
    (acp) =>
      Effect.gen(function* () {
        yield* acp.start();
        const configOptions = yield* acp.getConfigOptions;
        const modelOption = configOptions.find((option) => option.id === "model");
        return buildDevinDiscoveredModels(flattenModelSelectOptions(modelOption));
      }),
    environment,
  );

export function getDevinFallbackModels(
  devinSettings: Pick<DevinSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [{ slug: "adaptive", name: "Adaptive", isCustom: false, capabilities: EMPTY_CAPABILITIES }],
    devinSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

/** `devin --version` prints e.g. `devin 3000.6.7 (260a97c8)`. */
export function parseDevinVersionOutput(output: string): string | null {
  const match = output.trim().match(/^devin\s+([^\s(]+)/im);
  return match?.[1]?.trim() || null;
}

export interface DevinAuthResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

export function parseDevinAuthStatusOutput(
  result: CommandResult,
  version: string | null,
): DevinAuthResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lower = combined.toLowerCase();
  const emailMatch = combined.match(/email:\s*([^\s]+)/i);
  const email = emailMatch?.[1]?.trim();

  if (
    lower.includes("not logged in") ||
    lower.includes("login required") ||
    lower.includes("authentication required") ||
    lower.includes("not authenticated")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Devin CLI is not authenticated. Run `devin auth login` and try again.",
    };
  }

  if (result.code === 0 && (lower.includes("logged in") || email)) {
    return {
      version,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(email ? { email } : {}),
      },
    };
  }

  if (result.code === 0) {
    return { version, status: "ready", auth: { status: "unknown" } };
  }

  return {
    version,
    status: "warning",
    auth: { status: "unknown" },
    message: "Could not verify Devin CLI authentication status.",
  };
}

function buildDevinCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Devin CLI command \`${binaryPath}\` was not found.`,
    `Install or enable the Devin CLI, make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
    `See ${DEVIN_CLI_INSTALLATION_DOCS_URL}.`,
  ].join(" ");
}

export function buildDevinProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly devinSettings: DevinSettings;
  readonly parsed: DevinAuthResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const parts = [input.parsed.message, input.discoveryWarning].filter(
    (message): message is string => !!message?.trim(),
  );
  const message = parts.length > 0 ? parts.join(" ") : undefined;
  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: input.devinSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      input.devinSettings.customModels,
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

const runDevinCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawnCommand = yield* resolveSpawnCommand(
      devinSettings.binaryPath,
      args,
      environment ? { env: environment } : {},
    );
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      ...(environment ? { env: environment } : { extendEnv: true }),
      shell: spawnCommand.shell,
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getDevinFallbackModels(devinSettings);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runDevinCommand(devinSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(8_000),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? buildDevinCliCommandMissingMessage(devinSettings.binaryPath)
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const version = parseDevinVersionOutput(versionProbe.success.value.stdout);

  const authProbe = yield* runDevinCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(8_000),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? buildDevinCliCommandMissingMessage(devinSettings.binaryPath)
          : "Failed to verify Devin CLI authentication status.",
      },
    });
  }

  if (Option.isNone(authProbe.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI timed out while running `devin auth status`.",
      },
    });
  }

  const parsed = parseDevinAuthStatusOutput(authProbe.success.value, version);

  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveryWarning: string | undefined;
  if (parsed.auth.status !== "unauthenticated") {
    const discoveryExit = yield* Effect.exit(
      discoverDevinModelsViaAcp(devinSettings, environment).pipe(
        Effect.timeoutOption(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("Devin ACP model discovery failed", {
        errorTag: causeErrorTag(discoveryExit.cause),
      });
      discoveryWarning = DEVIN_ACP_MODEL_DISCOVERY_FAILED_MESSAGE;
    } else if (Option.isNone(discoveryExit.value)) {
      discoveryWarning = `Devin ACP model discovery timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else if (discoveryExit.value.value.length === 0) {
      discoveryWarning = "Devin ACP model discovery returned no built-in models.";
    } else {
      discoveredModels = discoveryExit.value;
    }
  }
  return buildDevinProviderSnapshot({
    checkedAt,
    devinSettings,
    parsed,
    discoveredModels: Option.getOrElse(
      Option.filter(discoveredModels, (models) => models.length > 0),
      () => [] as const,
    ),
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});

/** Background maintenance enrichment. Model data comes from status checks only. */
export const enrichDevinSnapshot = (input: {
  readonly settings: DevinSettings;
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
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.asVoid),
    ),
  );
};

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "adaptive";
}

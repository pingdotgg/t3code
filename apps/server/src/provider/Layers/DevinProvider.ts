import type {
  DevinSettings,
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

/** Session command catalogs stay scoped to their workspace across health refreshes. */
export const makeDevinCommandCatalog = Effect.fn("makeDevinCommandCatalog")(function* (
  provider: ServerProviderShape,
) {
  const workspaces = yield* SubscriptionRef.make<NonNullable<ServerProvider["workspaceSnapshots"]>>(
    [],
  );
  const getSnapshot = Effect.all([provider.getSnapshot, SubscriptionRef.get(workspaces)]).pipe(
    Effect.map(([snapshot, workspaceSnapshots]) =>
      workspaceSnapshots.length > 0 ? { ...snapshot, workspaceSnapshots } : snapshot,
    ),
  );
  const snapshotForCwd = Effect.fn("DevinCommandCatalog.snapshotForCwd")(function* (cwd: string) {
    const machineSnapshot = yield* provider.getSnapshot;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        {
          cwd,
          checkedAt,
          slashCommands:
            entries.find((entry) => entry.cwd === cwd)?.slashCommands ??
            machineSnapshot.slashCommands,
          skills: entries.find((entry) => entry.cwd === cwd)?.skills ?? machineSnapshot.skills,
        },
      ].slice(-16),
    );
    const snapshot = yield* getSnapshot;
    return {
      ...snapshot,
      checkedAt,
      slashCommands:
        snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.slashCommands ??
        snapshot.slashCommands,
    };
  });
  const onAvailableCommands = Effect.fn("DevinCommandCatalog.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) {
    const seen = new Set([COMPACT_SLASH_COMMAND.name]);
    const slashCommands = [
      COMPACT_SLASH_COMMAND,
      ...commands.flatMap((command) => {
        const name = command.name.trim();
        if (!name || seen.has(name)) return [];
        seen.add(name);
        const description = command.description.trim();
        const hint = command.input?.hint.trim();
        return [
          {
            name,
            ...(description ? { description } : {}),
            ...(hint ? { input: { hint } } : {}),
          },
        ];
      }),
    ];
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    // Devin ACP advertises slash commands only; workspace skills stay at
    // whatever the machine snapshot reported (none today).
    const machineSkills = (yield* provider.getSnapshot).skills;
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        { cwd, checkedAt, slashCommands, skills: machineSkills },
      ].slice(-16),
    );
  });
  return {
    onAvailableCommands,
    snapshotForCwd,
    snapshot: {
      ...provider,
      getSnapshot,
      refresh: provider.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: Stream.merge(
        provider.streamChanges.pipe(Stream.map(() => undefined)),
        SubscriptionRef.changes(workspaces).pipe(Stream.map(() => undefined)),
      ).pipe(Stream.mapEffect(() => getSnapshot)),
    } satisfies ServerProviderShape,
  };
});

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Model discovery runs a full ACP `session/new` round trip, which is slower
// than an initialize-only probe because the CLI resolves the account catalog.
const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_CLI_INSTALLATION_DOCS_URL = "https://docs.devin.ai/cli";
const DEVIN_ACP_MODEL_DISCOVERY_FAILED_MESSAGE = [
  "Devin ACP model discovery failed.",
  "Devin CLI setup may be incomplete; run `devin auth login`, restart T3 Code, and try again.",
  `See ${DEVIN_CLI_INSTALLATION_DOCS_URL}.`,
  "Check server logs for ACP details.",
].join(" ");

/** Devin's router entry. It is always in the ACP model list and resolves server-side. */
export const DEVIN_DEFAULT_MODEL_SLUG = "adaptive";

const DEVIN_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_DEFAULT_MODEL_SLUG,
    name: "Adaptive",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

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

interface DevinSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<DevinSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies DevinSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies DevinSessionSelectOption,
        ),
  );
}

function normalizeDevinReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "medium":
    case "high":
    case "max":
      return normalized;
    default:
      return undefined;
  }
}

function findDevinThoughtLevelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return (
    configOptions.find((option) => option.id.trim() === "thought_level") ??
    configOptions.find((option) => option.type === "select" && option.category === "thought_level")
  );
}

export function buildDevinCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const thoughtLevelOption = findDevinThoughtLevelConfigOption(configOptions);
  const thoughtLevelOptions =
    thoughtLevelOption?.type === "select"
      ? flattenSessionConfigSelectOptions(thoughtLevelOption).flatMap((entry) => {
          const normalizedValue = normalizeDevinReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name || normalizedValue,
              ...(normalizeDevinReasoningValue(thoughtLevelOption.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  return createModelCapabilities({
    optionDescriptors:
      thoughtLevelOptions.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoning",
              label: thoughtLevelOption?.name?.trim() || "Reasoning",
              options: thoughtLevelOptions,
            }),
          ]
        : [],
  });
}

function buildDevinDiscoveredModels(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions.find(
    (option) => option.type === "select" && option.category === "model",
  );
  const capabilities = buildDevinCapabilitiesFromConfigOptions(configOptions);
  const currentValue = modelOption?.type === "select" ? modelOption.currentValue.trim() : "";
  const seen = new Set<string>();
  return flattenSessionConfigSelectOptions(modelOption).flatMap((entry) => {
    const slug = entry.value;
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: entry.name || slug,
        isCustom: false,
        ...(slug === currentValue ? { isDefault: true } : {}),
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

const makeDevinAcpProbeRuntime = (devinSettings: DevinSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
        // Devin uses the credentials stored by `devin auth login`; there is no
        // ACP authenticate round trip for it.
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
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
        const started = yield* acp.start();
        const models = buildDevinDiscoveredModels(yield* acp.getConfigOptions);
        // Probing opens a real Devin session; delete it so health checks do
        // not accumulate empty sessions in `devin list`. A delete failure is
        // logged rather than failing discovery: the session was still created
        // either way, and dropping the catalog over cleanup is the worse trade.
        yield* acp.request("session/delete", { sessionId: started.sessionId }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Devin ACP probe session delete failed.", { cause }),
          ),
          Effect.ignore,
        );
        return models;
      }),
    environment,
  );

// Each driver instance owns its cache; version and account changes invalidate it.
export const makeDevinModelDiscovery = Effect.fn("makeDevinModelDiscovery")(function* (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const cache = yield* Cache.makeWith(
    (_key: string) => discoverDevinModelsViaAcp(devinSettings, environment),
    {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(30) : Duration.zero,
    },
  );
  return {
    discover: (probe: Pick<DevinCliProbe, "version" | "auth">) =>
      Cache.get(cache, JSON.stringify([probe.version, probe.auth])),
    invalidate: Cache.invalidateAll(cache),
  };
});

function getDevinFallbackModels(
  devinSettings: Pick<DevinSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    DEVIN_FALLBACK_MODELS,
    devinSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export interface DevinCliProbe {
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

function buildDevinCliCommandMissingMessage(binaryPath: string): string {
  return [
    `Devin CLI command \`${binaryPath}\` was not found.`,
    `Install the Devin CLI and make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
    `See ${DEVIN_CLI_INSTALLATION_DOCS_URL}.`,
  ].join(" ");
}

export function buildDevinProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly devinSettings: DevinSettings;
  readonly parsed: DevinCliProbe;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: input.devinSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels && input.discoveredModels.length > 0
        ? input.discoveredModels
        : DEVIN_FALLBACK_MODELS,
      input.devinSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    slashCommands: [COMPACT_SLASH_COMMAND],
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

function extractDevinAuthField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^\\s*${key}:\\s+(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

/**
 * Parse `devin auth status` output. The command exits 0 in both states, so the
 * text is the only signal. Authenticated output starts with `Logged in.` and
 * carries a `User:` block with an `Email:` line; logged-out output starts with
 * `Not logged in.` and ends with a `devin auth login` hint.
 */
export function parseDevinAuthStatus(result: CommandResult): {
  readonly auth: ServerProviderAuth;
  readonly message?: string;
} {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/not logged in/i.test(combined)) {
    return {
      auth: { status: "unauthenticated" },
      message: "Devin CLI is not authenticated. Run `devin auth login` and try again.",
    };
  }
  if (/logged in/i.test(combined)) {
    const email = extractDevinAuthField(combined, "Email");
    const tier = extractDevinAuthField(combined, "Tier");
    return {
      auth: {
        status: "authenticated",
        ...(email ? { email } : {}),
        ...(tier
          ? { type: tier.toLowerCase().replace(/[\s_-]+/g, "_"), label: tier }
          : { type: "devin", label: "Devin account" }),
      },
    };
  }
  return {
    auth: { status: "unknown" },
    ...(result.code === 0 ? {} : { message: "Could not verify Devin CLI authentication status." }),
  };
}

export function resolveDevinAcpModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEVIN_DEFAULT_MODEL_SLUG;
}

function normalizeDevinConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

export function resolveDevinAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{
    readonly configId: string;
    readonly value: string | boolean;
  }> = [];

  const thoughtLevelOption = findDevinThoughtLevelConfigOption(configOptions);
  const requestedReasoning = normalizeDevinReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (thoughtLevelOption && requestedReasoning) {
    const value = flattenSessionConfigSelectOptions(thoughtLevelOption).find(
      (option) =>
        normalizeDevinReasoningValue(option.value) === requestedReasoning ||
        normalizeDevinConfigOptionToken(option.name) === requestedReasoning,
    )?.value;
    if (value) {
      updates.push({ configId: thoughtLevelOption.id, value });
    }
  }

  return updates;
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      args,
      environment ? { env: environment } : {},
    );
    const childProcess = environment
      ? ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
        })
      : ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          extendEnv: true,
          shell: spawnCommand.shell,
        });
    return yield* spawnAndCollect(command, childProcess);
  });

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
  discoverModels?: (probe: DevinCliProbe) => ReturnType<typeof discoverDevinModelsViaAcp>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
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

  const versionResult = yield* runDevinCliCommand(devinSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
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

  if (Option.isNone(versionResult.success)) {
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

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
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
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const authResult = yield* runDevinCliCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const authOutput =
    Result.isSuccess(authResult) && Option.isSome(authResult.success)
      ? authResult.success.value
      : undefined;
  if (!authOutput) {
    yield* Effect.logWarning("Devin CLI auth status probe failed or timed out.", {
      errorTag: Result.isFailure(authResult) ? authResult.failure._tag : "Timeout",
    });
  }
  const parsedAuth = authOutput
    ? parseDevinAuthStatus(authOutput)
    : { auth: { status: "unknown" } satisfies ServerProviderAuth };

  const parsed: DevinCliProbe = {
    version,
    status: parsedAuth.auth.status === "unauthenticated" ? "error" : "ready",
    auth: parsedAuth.auth,
    ...(parsedAuth.message ? { message: parsedAuth.message } : {}),
  };

  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveryWarning: string | undefined;
  if (parsed.auth.status !== "unauthenticated") {
    const discoveryExit = yield* Effect.exit(
      (discoverModels
        ? discoverModels(parsed)
        : discoverDevinModelsViaAcp(devinSettings, environment)
      ).pipe(Effect.timeoutOption(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS)),
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

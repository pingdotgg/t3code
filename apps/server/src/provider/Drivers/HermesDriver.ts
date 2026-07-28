import {
  HermesSettings,
  ProviderDriverKind,
  TextGenerationError,
  type HermesGatewayCommandsCatalogResult,
  type HermesGatewayFastConfigResult,
  type HermesGatewayModelOptionsResult,
  type HermesGatewayReasoningConfigResult,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { assessHermesConnectionSecurity } from "../../hermes/HermesConnectionSecurity.ts";
import { HermesGatewayClient } from "../../hermes/HermesGatewayClient.ts";
import {
  makeHermesServeRuntime,
  type HermesServeOwnership,
} from "../../hermes/HermesServeRuntime.ts";
import {
  makeHermesServeAdapterV2Driver,
  resolveHermesGatewayToken,
  resolveHermesRemotePairingToken,
  resolveHermesRemoteTlsCertificateSha256,
  type HermesServeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/HermesServeAdapterV2.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { makeHermesSessionCatalog } from "../../hermes/HermesSessionCatalog.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const decodeSettings = Schema.decodeSync(HermesSettings);

const unsupportedTextGeneration = (): TextGenerationShape => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Hermes instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

const HERMES_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

const reasoningLabel = (effort: string): string =>
  effort === "xhigh" ? "Extra High" : effort.charAt(0).toUpperCase() + effort.slice(1);

const HERMES_FALLBACK_COMMANDS = [
  ["start", "Acknowledge platform start pings without a reply"],
  ["new", "Start a new chat (usage: /new [name])"],
  ["clear", "Clear the visible T3 Work timeline without resetting Hermes context"],
  ["topic", "Enable or inspect Telegram DM topic sessions (usage: /topic [off|help|session-id])"],
  ["retry", "Retry the last message (resend to agent)"],
  ["undo", "Back up N user turns and re-prompt (default 1) (usage: /undo [N])"],
  ["title", "Set a title for the current session (usage: /title [name])"],
  ["branch", "Branch the current session (explore a different path) (usage: /branch [name])"],
  [
    "compress",
    "Compress conversation context (usage: /compress [here [N] | focus topic | --preview|--dry-run])",
  ],
  ["rollback", "List or restore filesystem checkpoints (usage: /rollback [number])"],
  ["stop", "Kill all running background processes"],
  ["approve", "Approve a pending dangerous command (usage: /approve [session|always])"],
  ["deny", "Deny a pending dangerous command (usage: /deny [all] [reason])"],
  ["background", "Run a prompt in the background (usage: /background <prompt>)"],
  ["agents", "Show active agents and running tasks"],
  ["queue", "Queue a prompt for the next turn (usage: /queue <prompt>)"],
  ["steer", "Inject a message after the next tool call (usage: /steer <prompt>)"],
  [
    "goal",
    "Set or manage a standing goal (usage: /goal [text | draft <text> | show | pause | resume | clear | status | wait <pid> | unwait])",
  ],
  ["moa", "Run one prompt through the default Mixture of Agents preset (usage: /moa <prompt>)"],
  [
    "subgoal",
    "Add or manage criteria on the active goal (usage: /subgoal [text | remove N | clear])",
  ],
  ["status", "Show session, model, token, and context info"],
  ["egress", "Show Docker egress proxy status (usage: /egress [status])"],
  ["whoami", "Show your slash command access"],
  ["profile", "Show active profile name and home directory"],
  ["sethome", "Set this chat as the home channel"],
  ["resume", "Resume a previously-named session (usage: /resume [name])"],
  ["sessions", "Browse and resume previous sessions"],
  [
    "model",
    "Switch model (usage: /model [model] [--provider name] [--global|--session] [--refresh])",
  ],
  [
    "codex-runtime",
    "Toggle codex app-server runtime for OpenAI/Codex models (usage: /codex-runtime [auto|codex_app_server])",
  ],
  ["personality", "Set a predefined personality (usage: /personality [name])"],
  ["verbose", "Cycle tool progress display: off → new → all → verbose → log"],
  ["footer", "Toggle gateway runtime-metadata footer (usage: /footer [on|off|status])"],
  ["yolo", "Toggle YOLO mode"],
  ["reasoning", "Manage reasoning effort and display"],
  ["fast", "Toggle fast processing mode (usage: /fast [normal|fast|status] [--global])"],
  ["voice", "Toggle voice mode (usage: /voice [on|off|tts|status])"],
  ["skills", "Search, install, inspect, or manage skills"],
  ["memory", "Review pending memory writes or toggle the approval gate"],
  ["bundles", "List skill bundles"],
  ["learn", "Learn a reusable skill (usage: /learn <what to learn from>)"],
  ["suggestions", "Review suggested automations"],
  ["blueprint", "Set up an automation from a blueprint template"],
  ["curator", "Manage background skill maintenance"],
  ["kanban", "Manage the multi-profile collaboration board"],
  ["reload-mcp", "Reload MCP servers from config"],
  ["reload-skills", "Re-scan installed skills"],
  ["commands", "Browse all commands and skills (usage: /commands [page])"],
  ["help", "Show available commands"],
  ["restart", "Gracefully restart the gateway after draining active runs"],
  ["usage", "Show token usage and rate limits"],
  ["topup", "Show Nous balance and billing options"],
  ["insights", "Show usage insights and analytics (usage: /insights [days])"],
  [
    "platform",
    "Pause, resume, or list a failing gateway platform (usage: /platform <pause|resume|list> [name])",
  ],
  ["update", "Update Hermes Agent to the latest version"],
  ["version", "Show Hermes Agent version"],
  ["debug", "Upload a debug report (usage: /debug [nous|local])"],
] as const;

export const HERMES_FALLBACK_COMMAND_CATALOG: HermesGatewayCommandsCatalogResult = {
  pairs: HERMES_FALLBACK_COMMANDS.map(([name, description]) => [`/${name}`, description]),
  canon: {
    "/reset": "/new",
    "/fork": "/branch",
    "/compact": "/compress",
    "/bg": "/background",
    "/btw": "/background",
    "/tasks": "/agents",
    "/q": "/queue",
    "/set-home": "/sethome",
    "/codex_runtime": "/codex-runtime",
    "/suggest": "/suggestions",
    "/bp": "/blueprint",
    "/reload_mcp": "/reload-mcp",
    "/reload_skills": "/reload-skills",
    "/v": "/version",
  },
  sub: {
    "/topic": ["off", "help", "session-id"],
    "/approve": ["session", "always"],
    "/deny": ["all"],
    "/goal": ["draft", "show", "pause", "resume", "clear", "status", "wait", "unwait"],
    "/subgoal": ["remove", "clear"],
    "/egress": ["status"],
    "/codex-runtime": ["auto", "codex_app_server"],
    "/verbose": ["off", "new", "all", "verbose", "log"],
    "/footer": ["on", "off", "status"],
    "/reasoning": [...HERMES_REASONING_EFFORTS, "show", "hide", "full", "clamp", "--global"],
    "/fast": ["normal", "fast", "status", "on", "off", "--global"],
    "/voice": ["on", "off", "tts", "status"],
    "/skills": [
      "search",
      "browse",
      "inspect",
      "install",
      "audit",
      "pending",
      "approve",
      "reject",
      "diff",
      "approval",
    ],
    "/memory": ["pending", "approve", "reject", "approval"],
    "/suggestions": ["accept", "dismiss", "catalog", "clear"],
    "/curator": ["status", "run", "pause", "resume", "pin", "unpin", "restore", "list-archived"],
    "/platform": ["pause", "resume", "list"],
  },
  warning: "Using the built-in Hermes command catalog because gateway probing is unavailable.",
};

const displayModelName = (model: string): string => {
  const parts = model.replace(/^.*[/:]/u, "").split("-");
  if (/^gpt$/iu.test(parts[0] ?? "") && /^\d/u.test(parts[1] ?? "")) {
    return [
      `GPT-${parts[1]}`,
      ...parts.slice(2).map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
    ].join(" ");
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
};

export function hermesProviderModels(
  inventory: HermesGatewayModelOptionsResult | undefined,
  reasoning: HermesGatewayReasoningConfigResult | undefined,
  fast: HermesGatewayFastConfigResult | undefined,
  fallbackModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const effectiveModel = inventory?.model?.trim();
  const inventoryModels = (() => {
    const bySlug = new Map<
      string,
      ServerProviderModel & {
        readonly providerCapabilities?: {
          readonly fast?: boolean | undefined;
          readonly reasoning?: boolean | undefined;
        };
      }
    >();
    for (const provider of inventory?.providers ?? []) {
      for (const model of provider.models ?? []) {
        if (bySlug.has(model)) continue;
        const providerCapabilities = provider.capabilities?.[model];
        bySlug.set(model, {
          slug: model,
          name: displayModelName(model),
          subProvider: provider.name,
          isCustom: false,
          capabilities: null,
          ...(providerCapabilities === undefined ? {} : { providerCapabilities }),
        });
      }
    }
    return [...bySlug.values()];
  })();
  const models: Array<
    ServerProviderModel & {
      readonly providerCapabilities?: {
        readonly fast?: boolean | undefined;
        readonly reasoning?: boolean | undefined;
      };
    }
  > =
    inventoryModels.length > 0 && effectiveModel
      ? [
          {
            slug: "default",
            name: displayModelName(effectiveModel),
            isCustom: false,
            isDefault: true,
            capabilities: null,
            ...(() => {
              const providers = inventory?.providers ?? [];
              const preferred = providers.filter(
                (provider) => provider.is_current === true || provider.slug === inventory?.provider,
              );
              const owner = [...preferred, ...providers].find((provider) =>
                provider.models?.includes(effectiveModel),
              );
              const providerCapabilities = owner?.capabilities?.[effectiveModel];
              return providerCapabilities === undefined ? {} : { providerCapabilities };
            })(),
          },
          ...inventoryModels.filter((model) => model.slug !== "default"),
        ]
      : Array.from(new Set(fallbackModels)).map((model) => ({
          slug: model,
          name: model === "default" ? "Hermes configured model" : displayModelName(model),
          isCustom: model !== "default",
          ...(model === "default" ? { isDefault: true } : {}),
          capabilities: null,
        }));
  const effectiveEffort = reasoning?.value || "medium";
  return models.map(({ providerCapabilities, ...model }) => {
    const optionDescriptors = [];
    if (providerCapabilities?.reasoning !== false) {
      optionDescriptors.push({
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        options: HERMES_REASONING_EFFORTS.map((effort) => ({
          id: effort,
          label: reasoningLabel(effort),
          ...(effort === effectiveEffort ? { isDefault: true } : {}),
        })),
        currentValue: effectiveEffort,
      });
    }
    if (providerCapabilities?.fast === true) {
      const effectiveFast = fast?.value ?? "normal";
      optionDescriptors.push({
        id: "fast",
        label: "Processing",
        type: "select" as const,
        options: [
          {
            id: "normal",
            label: "Normal",
            ...(effectiveFast === "normal" ? { isDefault: true } : {}),
          },
          { id: "fast", label: "Fast", ...(effectiveFast === "fast" ? { isDefault: true } : {}) },
        ],
        currentValue: effectiveFast,
      });
    }
    return {
      ...model,
      capabilities:
        optionDescriptors.length === 0 ? null : createModelCapabilities({ optionDescriptors }),
    };
  });
}

export function hermesSlashCommands(
  catalog: HermesGatewayCommandsCatalogResult | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  const effectiveCatalog = catalog?.pairs === undefined ? HERMES_FALLBACK_COMMAND_CATALOG : catalog;
  const catalogPairs = effectiveCatalog.pairs ?? HERMES_FALLBACK_COMMAND_CATALOG.pairs ?? [];
  const seen = new Set<string>();
  const commands = catalogPairs.flatMap(([wireName, rawDescription]) => {
    const name = wireName.replace(/^\/+/u, "").trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const description = rawDescription.trim();
    const subcommands = effectiveCatalog.sub?.[name] ?? effectiveCatalog.sub?.[wireName] ?? [];
    const usageHint = description.match(/\(usage:\s*\/\S+\s+(.+)\)$/iu)?.[1]?.trim();
    const inputHint = subcommands.length > 0 ? subcommands.join(" | ") : usageHint;
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(inputHint ? { input: { hint: inputHint } } : {}),
      },
    ];
  });
  for (const [aliasWireName, canonicalWireName] of Object.entries(effectiveCatalog.canon ?? {})) {
    const alias = aliasWireName.replace(/^\/+/u, "").trim();
    const canonical = canonicalWireName.replace(/^\/+/u, "").trim();
    if (!alias || alias === canonical || seen.has(alias)) continue;
    seen.add(alias);
    const canonicalInput = commands.find((command) => command.name === canonical)?.input;
    commands.push({
      name: alias,
      description: `Alias for /${canonical}`,
      ...(canonicalInput ? { input: canonicalInput } : {}),
    });
  }
  for (const native of [
    { name: "new", description: "Start a new chat" },
    { name: "reset", description: "Start a new chat" },
    {
      name: "clear",
      description: "Clear the visible T3 Work timeline without resetting Hermes context",
    },
  ] as const) {
    if (seen.has(native.name)) continue;
    seen.add(native.name);
    commands.push(native);
  }
  return commands;
}

function snapshot(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly settings: HermesSettings;
  readonly gatewayToken: string | undefined;
  readonly remotePairingToken: string | undefined;
  readonly remoteTlsCertificateSha256: string | undefined;
  readonly continuationKey: string;
  readonly checkedAt: string;
  readonly inventory?: {
    readonly commands?: HermesGatewayCommandsCatalogResult;
    readonly models?: HermesGatewayModelOptionsResult;
    readonly reasoning?: HermesGatewayReasoningConfigResult;
    readonly fast?: HermesGatewayFastConfigResult;
  };
  readonly inventoryWarning?: string;
  readonly effectiveEndpoint: string;
  readonly connectionOwnership?: HermesServeOwnership;
}): ServerProvider {
  const models = hermesProviderModels(
    input.inventory?.models,
    input.inventory?.reasoning,
    input.inventory?.fast,
    ["default", ...input.settings.customModels],
  );
  const hasProfileKey = input.settings.profileKey.trim().length > 0;
  const connectionSecurity = input.effectiveEndpoint
    ? assessHermesConnectionSecurity({
        endpoint: input.effectiveEndpoint,
        gatewayToken: input.gatewayToken,
        remoteGloballyEnabled: input.enabled,
        remoteInstanceEnabled: input.settings.remoteAccessEnabled,
        remotePairingToken: input.remotePairingToken,
        remoteTlsCertificateSha256: input.remoteTlsCertificateSha256,
      })
    : undefined;
  const hasGatewayToken = input.gatewayToken !== undefined;
  const isConfigured = hasProfileKey && connectionSecurity?.status === "ready";
  const isUnauthenticated =
    !input.enabled ||
    !hasGatewayToken ||
    (connectionSecurity?.status !== "ready" &&
      connectionSecurity?.code === "remote_pairing_required") ||
    (!hasGatewayToken && connectionSecurity?.scope === "loopback");
  const isAuthenticated =
    hasGatewayToken &&
    input.inventory !== undefined &&
    Object.values(input.inventory).some((value) => value !== undefined);
  const configurationMessage = !input.enabled
    ? undefined
    : !hasProfileKey
      ? "Configure a Hermes profile key before starting a thread."
      : !hasGatewayToken
        ? "Add a sensitive HERMES_GATEWAY_TOKEN. T3 will use it to attach to an existing Hermes Serve instance or securely launch its own."
        : connectionSecurity?.status === "ready"
          ? (input.inventoryWarning ??
            (input.connectionOwnership === "t3_owned"
              ? "Running a private Hermes Serve process managed by T3 Work."
              : input.connectionOwnership === "external"
                ? "Attached to an existing Hermes Serve instance."
                : undefined))
          : connectionSecurity?.message;
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
    enabled: input.enabled,
    installed: true,
    version: null,
    status: !input.enabled
      ? "disabled"
      : isConfigured && input.inventoryWarning === undefined
        ? "ready"
        : "warning",
    auth: {
      status: isUnauthenticated ? "unauthenticated" : isAuthenticated ? "authenticated" : "unknown",
    },
    checkedAt: input.checkedAt,
    ...(configurationMessage === undefined ? {} : { message: configurationMessage }),
    models,
    slashCommands: hermesSlashCommands(input.inventory?.commands),
    skills: [],
  };
}

export type HermesDriverEnv =
  | HermesServeAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner;

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const gatewayToken = resolveHermesGatewayToken(environment);
      const connectionRuntime = yield* makeHermesServeRuntime({
        endpoint: config.endpoint,
        authToken: gatewayToken,
        managedServerEnabled: config.managedServerEnabled,
        processEnvironment: mergeProviderInstanceEnvironment(environment),
      });
      const orchestrationAdapter = yield* makeHermesServeAdapterV2Driver(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        { connectionRuntime },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Hermes orchestration adapter.",
              cause,
            }),
        ),
      );
      const remotePairingToken = resolveHermesRemotePairingToken(environment);
      const remoteTlsCertificateSha256 = resolveHermesRemoteTlsCertificateSha256(environment);
      let inventory:
        | {
            readonly commands?: HermesGatewayCommandsCatalogResult;
            readonly models?: HermesGatewayModelOptionsResult;
            readonly reasoning?: HermesGatewayReasoningConfigResult;
            readonly fast?: HermesGatewayFastConfigResult;
          }
        | undefined;
      let inventoryWarning: string | undefined;
      let connectionOwnership: HermesServeOwnership | undefined;
      const currentSnapshot = () =>
        snapshot({
          instanceId,
          displayName,
          accentColor,
          enabled,
          settings: config,
          gatewayToken,
          remotePairingToken,
          remoteTlsCertificateSha256,
          continuationKey: continuationIdentity.continuationKey,
          checkedAt,
          effectiveEndpoint: connectionRuntime.effectiveEndpoint,
          ...(inventory === undefined ? {} : { inventory }),
          ...(inventoryWarning === undefined ? {} : { inventoryWarning }),
          ...(connectionOwnership === undefined ? {} : { connectionOwnership }),
        });
      const refreshSnapshot = Effect.gen(function* () {
        if (!enabled || !config.profileKey.trim()) {
          return currentSnapshot();
        }
        inventory = undefined;
        inventoryWarning = undefined;
        connectionOwnership = undefined;
        const resolvedConnection = yield* Effect.result(connectionRuntime.ensureReady);
        if (resolvedConnection._tag === "Failure") {
          inventoryWarning = resolvedConnection.failure.message;
          return currentSnapshot();
        }
        connectionOwnership = resolvedConnection.success.ownership;
        const security = assessHermesConnectionSecurity({
          endpoint: resolvedConnection.success.endpoint,
          gatewayToken: resolvedConnection.success.authToken,
          remoteGloballyEnabled: enabled,
          remoteInstanceEnabled: config.remoteAccessEnabled,
          remotePairingToken,
          remoteTlsCertificateSha256,
        });
        if (security.status !== "ready") return currentSnapshot();
        if (security.scope !== "loopback") {
          inventoryWarning =
            "Hermes command/model inventory probing is unavailable for remote gateways in this build.";
          return currentSnapshot();
        }
        const client = new HermesGatewayClient({
          endpoint: security.endpoint,
          authToken: security.authToken,
          reconnect: { maxAttempts: 0 },
        });
        const probeResult = yield* Effect.tryPromise({
          try: async () => {
            await client.connect();
            const [commandsResult, modelsResult, reasoningResult, fastResult] =
              await Promise.allSettled([
                client.readCommandsCatalog(),
                client.readModelOptions({
                  explicit_only: true,
                  include_unconfigured: false,
                }),
                client.readReasoningConfig(),
                client.readFastConfig(),
              ]);
            return { commandsResult, modelsResult, reasoningResult, fastResult };
          },
          catch: (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Hermes command and model inventory probe failed.",
              cause,
            }),
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              client.close();
            }),
          ),
          Effect.result,
        );
        if (probeResult._tag === "Failure") {
          inventoryWarning =
            "Hermes Serve connected, but its command and model inventory could not be read.";
          return currentSnapshot();
        }
        const { commandsResult, modelsResult, reasoningResult, fastResult } = probeResult.success;
        inventory = {
          ...(commandsResult.status === "fulfilled" ? { commands: commandsResult.value } : {}),
          ...(modelsResult.status === "fulfilled" ? { models: modelsResult.value } : {}),
          ...(reasoningResult.status === "fulfilled" ? { reasoning: reasoningResult.value } : {}),
          ...(fastResult.status === "fulfilled" ? { fast: fastResult.value } : {}),
        };
        const probeWarnings: Array<string> = [];
        if (commandsResult.status === "fulfilled") {
          const warning = commandsResult.value.warning?.trim();
          if (warning) probeWarnings.push(warning);
        } else {
          probeWarnings.push(
            "Hermes command probing is unavailable; using the built-in command catalog.",
          );
        }
        if (modelsResult.status === "rejected") {
          probeWarnings.push(
            "Hermes model options probing is unavailable; using the built-in model catalog.",
          );
        }
        if (reasoningResult.status === "rejected") {
          probeWarnings.push("Hermes reasoning configuration could not be read.");
        }
        if (fastResult.status === "rejected") {
          probeWarnings.push("Hermes fast-mode configuration could not be read.");
        }
        inventoryWarning = probeWarnings.length > 0 ? probeWarnings.join(" ") : undefined;
        return currentSnapshot();
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
          getSnapshot: refreshSnapshot,
          refresh: refreshSnapshot,
          streamChanges: Stream.empty,
        },
        orchestrationAdapter,
        // A disabled instance must not expose session discovery or import;
        // calling the catalog could otherwise start a managed Hermes process.
        ...(enabled
          ? {
              hermesSessionCatalog: makeHermesSessionCatalog({
                providerInstanceId: instanceId,
                endpoint: connectionRuntime.effectiveEndpoint,
                authToken: gatewayToken,
                remoteGloballyEnabled: enabled,
                remoteInstanceEnabled: config.remoteAccessEnabled,
                remotePairingToken,
                remoteTlsCertificateSha256,
                profileKey: config.profileKey,
                importEnabled: config.importEnabled,
                ensureReady: connectionRuntime.ensureReady,
              }),
            }
          : {}),
        textGeneration: unsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};

import {
  type ModelCapabilities,
  type OpenCodeSettings,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import type { ProbedOpenCode } from "../opencodeVersionProbe.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";

const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;

class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause?: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly phase: "version" | "inventory";
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  const failureLabel =
    input.phase === "inventory"
      ? "Failed to load OpenCode provider inventory"
      : "Failed to execute OpenCode CLI health check";
  return {
    installed: true,
    message: detail ? `${failureLabel}: ${detail}` : `${failureLabel}.`,
  };
}

function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
      ],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [
        { id: "build", label: "Build", isDefault: true },
        { id: "plan", label: "Plan" },
      ],
      currentValue: "build",
    },
  ],
});

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const rawVariantValues = Object.keys(input.model.variants ?? {});
  // When a model advertises no variants, synthesize the standard reasoning
  // levels so the composer still offers a Reasoning selector (mirrors the
  // Codex/Grok experience where reasoning is always configurable). The set
  // covers the common OpenCode variant spectrum; `inferDefaultVariant`
  // picks the provider-appropriate default (e.g. medium for openai/opencode).
  const variantValues =
    rawVariantValues.length > 0 ? rawVariantValues : ["low", "medium", "high", "xhigh"];
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Reasoning",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenOpenCodeModels(
  input: OpenCodeRuntime.OpenCodeInventory,
): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function openCodeSkillsToServerProviderSkills(
  input: OpenCodeRuntime.OpenCodeInventory["skills"] | undefined,
): ReadonlyArray<ServerProviderSkill> {
  const skills: ServerProviderSkill[] = [];
  for (const skill of input ?? []) {
    const name = trimOptional(skill.name);
    const path = trimOptional(skill.location);
    if (!name || !path) {
      continue;
    }

    const description = trimOptional(skill.description);
    skills.push({
      name,
      path,
      enabled: true,
      ...(description ? { description, shortDescription: description } : {}),
    });
  }

  return skills.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function openCodeCommandsToServerProviderSlashCommands(
  input: OpenCodeRuntime.OpenCodeInventory["commands"],
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands: ServerProviderSlashCommand[] = [COMPACT_SLASH_COMMAND];
  const names = new Set([COMPACT_SLASH_COMMAND.name]);
  for (const command of input ?? []) {
    const name = trimOptional(command.name);
    if (!name || names.has(name) || command.source === "skill") continue;
    names.add(name);
    const description = trimOptional(command.description);
    const hint = trimOptional(command.hints.join(" "));
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return commands;
}

export const makePendingOpenCodeProvider = (
  openCodeSettings: OpenCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      openCodeSettings.customModels,
      DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    );

    if (!openCodeSettings.enabled) {
      return buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message:
            openCodeSettings.serverUrl.trim().length > 0
              ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
              : "OpenCode is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode provider status has not been checked in this session yet.",
      },
    });
  });

/** One model an OpenCode 2 server lists, as the status check reads it. */
export interface OpenCode2Model {
  readonly providerID: string;
  readonly id: string;
  readonly name: string;
  readonly variants: ReadonlyArray<{ readonly id: string }>;
}

/**
 * A server loads its catalog lazily and lists nothing for its first few
 * hundred milliseconds, and a local instance starts a fresh server for each
 * status check. So an empty list is read again for a while, and the last
 * non-empty list stands in if the catalog still has not loaded.
 */
export const makeOpenCode2ModelLoader = <E>(
  list: Effect.Effect<ReadonlyArray<OpenCode2Model>, E>,
) =>
  Effect.sync(() => {
    let lastLoaded: ReadonlyArray<OpenCode2Model> = [];
    return list.pipe(
      Effect.repeat({
        until: (models) => models.length > 0,
        schedule: Schedule.spaced("250 millis"),
      }),
      Effect.timeoutOption("5 seconds"),
      Effect.map((loaded) => {
        if (loaded._tag === "Some" && loaded.value.length > 0) lastLoaded = loaded.value;
        return lastLoaded;
      }),
    );
  });

/** A workspace's skills and commands, as an OpenCode 2 server lists them for its directory. */
export interface OpenCode2Workspace {
  readonly skills: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly description?: string | undefined;
  }>;
  readonly commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
  }>;
}

/**
 * A server scans a directory it has not served yet in the background: its
 * first read lists no commands at all (not even the built-ins), and
 * `command.updated` plus `skill.updated` for the directory end the scan. A
 * directory it already serves lists everything at once. `scanned` must be
 * listening before `read` runs, since the read is what starts the scan.
 */
export const loadOpenCode2Workspace = <E>(
  read: Effect.Effect<OpenCode2Workspace, E>,
  scanned: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const first = yield* read;
    if (first.commands.length > 0) return first;
    yield* scanned.pipe(Effect.timeoutOption("10 seconds"));
    return yield* read;
  });

export function openCode2SkillsToServerProviderSkills(
  skills: OpenCode2Workspace["skills"],
): ReadonlyArray<ServerProviderSkill> {
  return skills
    .map((skill) => {
      const description = trimOptional(skill.description);
      return {
        name: skill.id,
        path: skill.path,
        enabled: true,
        ...(skill.name === skill.id ? {} : { displayName: skill.name }),
        ...(description ? { description, shortDescription: description } : {}),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function openCode2CommandsToServerProviderSlashCommands(
  commands: OpenCode2Workspace["commands"],
): ReadonlyArray<ServerProviderSlashCommand> {
  const slashCommands: ServerProviderSlashCommand[] = [COMPACT_SLASH_COMMAND];
  const names = new Set([COMPACT_SLASH_COMMAND.name]);
  for (const command of commands) {
    const name = trimOptional(command.name);
    if (!name || names.has(name)) continue;
    names.add(name);
    const description = trimOptional(command.description);
    slashCommands.push({ name, ...(description ? { description } : {}) });
  }
  return slashCommands;
}

/**
 * Every mode maps onto OpenCode 2 session rules. Auto asks like Supervised:
 * OpenCode has no reviewer that approves routine actions. Plan mode is its
 * `plan` agent, so the composer's mode toggle drives it.
 */
const OPENCODE_2_PRESENTATION = {
  ...OPENCODE_PRESENTATION,
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;

function openCode2ModelCapabilities(model: OpenCode2Model): ModelCapabilities {
  const variants = model.variants.map((variant) => variant.id);
  const defaultVariant = inferDefaultVariant(model.providerID, variants);
  return createModelCapabilities({
    optionDescriptors:
      variants.length === 0
        ? []
        : [
            {
              id: "variant",
              label: "Reasoning",
              type: "select",
              options: variants.map((id) => ({
                id,
                label: titleCaseSlug(id),
                ...(id === defaultVariant ? { isDefault: true } : {}),
              })),
              ...(defaultVariant === undefined ? {} : { currentValue: defaultVariant }),
            },
          ],
  });
}

const checkOpenCode2 = Effect.fn("checkOpenCode2")(function* (
  settings: OpenCodeSettings,
  version: string,
  checkedAt: string,
  loadModels: Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError>,
) {
  const result = yield* Effect.exit(loadModels);
  const probe = (status: "ready" | "warning" | "error", message: string) => ({
    installed: true,
    version,
    status,
    auth: { status: status === "ready" ? ("authenticated" as const) : ("unknown" as const) },
    message,
  });
  if (result._tag === "Failure") {
    // The detail can carry a response body; it stays in the log, not the status.
    yield* Effect.logWarning("OpenCode 2 model list failed", result.cause);
    return buildServerProvider({
      presentation: OPENCODE_2_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        settings.customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      probe: probe("error", "OpenCode could not load its model list."),
    });
  }
  const models = providerModelsFromSettings(
    result.value
      .map((model) => ({
        slug: `${model.providerID}/${model.id}`,
        name: model.name,
        isCustom: false,
        capabilities: openCode2ModelCapabilities(model),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    settings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  return buildServerProvider({
    presentation: OPENCODE_2_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    // Every session can compact; a workspace snapshot adds that directory's commands.
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe:
      result.value.length > 0
        ? probe(
            "ready",
            `OpenCode ${version} lists ${result.value.length} model${result.value.length === 1 ? "" : "s"}.`,
          )
        : probe("warning", "OpenCode 2 is running, but it did not list any models yet."),
  });
});

/**
 * `probeRuntime` is the driver's memoized version probe: `opencode --version` for a local binary,
 * the version endpoints for a configured server. The status check refreshes it, so an in-place
 * upgrade re-routes the instance.
 */
export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  openCodeSettings: OpenCodeSettings,
  cwd: string,
  probeRuntime: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>,
  loadOpenCode2Models: Effect.Effect<
    ReadonlyArray<OpenCode2Model>,
    OpenCodeRuntime.OpenCodeRuntimeError
  >,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  OpenCodeRuntime.OpenCodeRuntime | OpenCodeServerOwner.OpenCodeServerOwner
> {
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = openCodeSettings.customModels;
  const isExternalServer = openCodeSettings.serverUrl.trim().length > 0;

  const fallback = (
    cause: unknown,
    version: string | null = null,
    phase: "version" | "inventory" = "version",
  ) => {
    const failure = formatOpenCodeProbeError({
      cause,
      isExternalServer,
      phase,
      serverUrl: openCodeSettings.serverUrl,
    });
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
          : "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  const probedExit = yield* Effect.exit(
    probeRuntime.pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeProbeError({
            cause,
            detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
          }),
      ),
    ),
  );
  if (probedExit._tag === "Failure") return fallback(Cause.squash(probedExit.cause));
  const probed = probedExit.value;
  if (probed.generation === "v2") {
    return yield* checkOpenCode2(openCodeSettings, probed.version, checkedAt, loadOpenCode2Models);
  }
  let version: string | null = probed.version;
  if (compareSemverVersions(probed.version, OpenCodeRuntime.MINIMUM_OPENCODE_VERSION) < 0) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
      probe: {
        installed: true,
        version: probed.version,
        status: "error",
        auth: { status: "unknown" },
        message: `OpenCode v${probed.version} is too old. Upgrade to v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer.`,
      },
    });
  }

  const loadInventory = (server: {
    readonly url: string;
    readonly serverPassword?: string;
    readonly version: string;
  }) =>
    openCodeRuntime
      .loadOpenCodeInventory(
        openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: cwd,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        }),
      )
      .pipe(Effect.map((inventory) => ({ inventory, version: server.version })));
  const inventoryEffect = isExternalServer
    ? openCodeRuntime
        .connectToOpenCodeServer({
          binaryPath: openCodeSettings.binaryPath,
          directory: cwd,
          serverUrl: openCodeSettings.serverUrl,
          ...(openCodeSettings.serverPassword
            ? { serverPassword: openCodeSettings.serverPassword }
            : {}),
        })
        .pipe(Effect.flatMap(loadInventory), Effect.scoped)
    : serverOwner.withServer(loadInventory);
  const inventoryExit = yield* Effect.exit(
    inventoryEffect.pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeProbeError({
            cause,
            detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
          }),
      ),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version, "inventory");
  }

  version = inventoryExit.value.version;

  const models = providerModelsFromSettings(
    flattenOpenCodeModels(inventoryExit.value.inventory),
    customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  const skills = openCodeSkillsToServerProviderSkills(inventoryExit.value.inventory.skills);
  const connectedCount = inventoryExit.value.inventory.providerList.connected.length;
  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills,
    slashCommands: openCodeCommandsToServerProviderSlashCommands(
      inventoryExit.value.inventory.commands,
    ),
    probe: {
      installed: true,
      version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "opencode",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
          : isExternalServer
            ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
            : "OpenCode is available, but it did not report any connected upstream providers.",
    },
  });
});

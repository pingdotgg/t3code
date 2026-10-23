import {
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
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
} from "@t3tools/provider-core/server/snapshotProbe";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import type { ProbedOpenCode } from "./versionProbe.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

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
}): {
  readonly installed: boolean;
  readonly message: string;
  readonly authStatus?: "unauthenticated";
} {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    // Bare auth-code digits can be part of the endpoint's port or path.
    if (
      /(?:^|\s)(?:status(?:\s+code)?(?:\s*[:=]\s*|\s+)|http(?:\/\d(?:\.\d)?)?\s+)(?:401|403)\b/.test(
        lower,
      ) ||
      /\b(?:unauthorized|forbidden)\b/.test(lower)
    ) {
      return {
        installed: true,
        authStatus: "unauthenticated",
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
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted. Try reinstalling OpenCode.",
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

// The status check owns the span; keep handled failures visible without adding another span.
const logDiscoveryFailure = Effect.fnUntraced(function* (input: {
  readonly phase: "version" | "inventory" | "models";
  readonly isExternalServer: boolean;
  readonly version?: string;
  readonly cause?: Cause.Cause<unknown>;
}) {
  const outcome = input.cause ? "failed" : "empty";
  const attributes = {
    provider: "opencode",
    phase: input.phase,
    outcome,
    serverMode: input.isExternalServer ? "external" : "managed",
    ...(input.version === undefined ? {} : { version: input.version }),
  };
  yield* Effect.annotateCurrentSpan({
    "discovery.phase": input.phase,
    "discovery.outcome": outcome,
  });
  yield* (
    input.cause
      ? Effect.logWarning("OpenCode discovery failed", input.cause)
      : Effect.logWarning("OpenCode discovery failed")
  ).pipe(Effect.annotateLogs(attributes));
});

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

interface OpenCodeRelease {
  readonly providerID: string;
  readonly family?: string | undefined;
  readonly released?: number | undefined;
  readonly deprecated?: boolean | undefined;
}

/**
 * OpenCode catalogs keep every release of a family, such as Claude Opus 4.5
 * through 5.5. Only the newest active release of each family within a
 * sub-provider stays current; older releases and deprecated models are legacy.
 */
function markOpenCodeLegacy(
  entries: ReadonlyArray<{
    readonly model: ServerProviderModel;
    readonly release: OpenCodeRelease;
  }>,
): Array<ServerProviderModel> {
  const familyKey = ({ providerID, family }: OpenCodeRelease) =>
    family ? `${providerID}/${family}` : undefined;
  const newest = new Map<string, number>();
  for (const { release } of entries) {
    const key = familyKey(release);
    if (key === undefined || release.released === undefined || release.deprecated) continue;
    newest.set(key, Math.max(newest.get(key) ?? release.released, release.released));
  }
  return entries.map(({ model, release }) => {
    const key = familyKey(release);
    const latest = key === undefined ? undefined : newest.get(key);
    const superseded =
      latest !== undefined && release.released !== undefined && release.released < latest;
    return release.deprecated || superseded ? { ...model, isLegacy: true } : model;
  });
}

function flattenOpenCodeModels(
  input: OpenCodeRuntime.OpenCodeInventory,
): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const entries: Array<{ model: ServerProviderModel; release: OpenCodeRelease }> = [];

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
      const released = Date.parse(model.release_date);
      entries.push({
        model: {
          slug: `${provider.id}/${model.id}`,
          name,
          ...(subProvider ? { subProvider } : {}),
          isCustom: false,
          capabilities: openCodeCapabilitiesForModel({
            providerID: provider.id,
            model,
            agents: input.agents,
          }),
        },
        release: {
          providerID: provider.id,
          family: model.family,
          released: Number.isNaN(released) ? undefined : released,
          deprecated: model.status === "deprecated",
        },
      });
    }
  }

  return markOpenCodeLegacy(entries).toSorted((left, right) => left.name.localeCompare(right.name));
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

export const makePendingOpenCodeProvider = Effect.fn(
  "OpencodeProviderStatus.makePendingOpenCodeProvider",
)(function* (openCodeSettings: OpenCodeSettings): Effect.fn.Return<ServerProviderDraft> {
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

export interface OpenCode2Model extends OpenCodeRelease {
  readonly id: string;
  readonly name: string;
  readonly providerName?: string;
  readonly variants: ReadonlyArray<{ readonly id: string }>;
}

/**
 * One OpenCode instance fronts several providers, and their catalogues overlap:
 * OpenCode Zen and OpenCode Go both list Step 5 Preview Free. Naming the
 * sub-provider is what tells two such rows apart.
 */
function subProviderLabelFor(input: {
  readonly providerID: string;
  readonly providerName?: string;
}): string | undefined {
  const label = nonEmptyTrimmed(input.providerName) ?? input.providerID;
  return label.toLowerCase() === OPENCODE_PRESENTATION.displayName.toLowerCase()
    ? undefined
    : label;
}

const catalogFingerprint = (models: ReadonlyArray<OpenCode2Model>) =>
  models
    .map((model) =>
      JSON.stringify([
        model.providerID,
        model.id,
        model.name,
        model.providerName,
        model.variants.map((variant) => variant.id).toSorted(),
      ]),
    )
    .toSorted()
    .join("\n");

/** A cold server can list a partial catalog; two agreeing reads reduce that startup race. */
export const makeOpenCode2ModelLoader = <E>(
  list: Effect.Effect<ReadonlyArray<OpenCode2Model>, E>,
) =>
  Effect.sync(() => {
    let lastLoaded: ReadonlyArray<OpenCode2Model> = [];
    return Effect.suspend(() => {
      let previous: string | undefined;
      let latest: ReadonlyArray<OpenCode2Model> = [];
      return list.pipe(
        Effect.repeat({
          until: (models) => {
            if (models.length > 0) latest = models;
            const fingerprint = models.length > 0 ? catalogFingerprint(models) : undefined;
            const settled = fingerprint !== undefined && fingerprint === previous;
            previous = fingerprint;
            return settled;
          },
          schedule: Schedule.spaced("250 millis"),
        }),
        Effect.catch((error) => (latest.length > 0 ? Effect.succeed(latest) : Effect.fail(error))),
        Effect.timeoutOption("5 seconds"),
        Effect.map((loaded) => {
          // Fresh progress may still be partial, but a warm cache must not freeze slow catalogs.
          if (loaded._tag === "Some") lastLoaded = loaded.value;
          else if (latest.length > 0) lastLoaded = latest;
          return lastLoaded;
        }),
      );
    });
  });

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
 * A server scans a directory it has not served yet in the background: its first read lists
 * no commands at all (not even the built-ins), and `command.updated` plus `skill.updated`
 * for the directory end the scan. `scanned` must be listening before `read` runs, since
 * the read is what starts the scan.
 */
export const loadOpenCode2Workspace = Effect.fn("OpencodeProviderStatus.loadOpenCode2Workspace")(
  function* <E>(read: Effect.Effect<OpenCode2Workspace, E>, scanned: Effect.Effect<void>) {
    const first = yield* read;
    if (first.commands.length > 0) return first;
    yield* scanned.pipe(Effect.timeoutOption("10 seconds"));
    return yield* read;
  },
);

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
 * Auto asks like Supervised: OpenCode has no reviewer that approves routine
 * actions.
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
    yield* logDiscoveryFailure({
      phase: "models",
      isExternalServer: settings.serverUrl.trim().length > 0,
      version,
      cause: result.cause,
    });
    return buildServerProvider({
      presentation: OPENCODE_2_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        settings.customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: probe("error", "OpenCode could not load its model list."),
    });
  }
  if (result.value.length === 0) {
    yield* logDiscoveryFailure({
      phase: "models",
      isExternalServer: settings.serverUrl.trim().length > 0,
      version,
    });
  }
  const models = providerModelsFromSettings(
    markOpenCodeLegacy(
      result.value.map((model) => {
        const subProvider = subProviderLabelFor(model);
        return {
          model: {
            slug: `${model.providerID}/${model.id}`,
            name: model.name,
            ...(subProvider ? { subProvider } : {}),
            isCustom: false,
            capabilities: openCode2ModelCapabilities(model),
          },
          release: model,
        };
      }),
    ).toSorted((left, right) => left.name.localeCompare(right.name)),
    settings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  return buildServerProvider({
    presentation: OPENCODE_2_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
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
        auth: { status: failure.authStatus ?? "unknown" },
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
  if (probedExit._tag === "Failure") {
    yield* logDiscoveryFailure({ phase: "version", isExternalServer, cause: probedExit.cause });
    return fallback(Cause.squash(probedExit.cause));
  }
  const probed = probedExit.value;
  if (probed.generation === "v2") {
    return yield* checkOpenCode2(openCodeSettings, probed.version, checkedAt, loadOpenCode2Models);
  }
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

  const installedVersion = isExternalServer ? {} : { installedVersion: probed.version };
  let version = probed.version;
  const loadInventory = Effect.fnUntraced(function* (server: {
    readonly url: string;
    readonly serverPassword?: string;
    readonly version: string;
  }) {
    // Preserve the helper's version even when its inventory request fails.
    version = server.version;
    return yield* openCodeRuntime.loadOpenCodeInventory(
      openCodeRuntime.createOpenCodeSdkClient({
        baseUrl: server.url,
        directory: cwd,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
      }),
    );
  });
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
    yield* logDiscoveryFailure({
      phase: "inventory",
      isExternalServer,
      version,
      cause: inventoryExit.cause,
    });
    return {
      ...fallback(Cause.squash(inventoryExit.cause), version, "inventory"),
      ...installedVersion,
    };
  }

  const inventoryModels = flattenOpenCodeModels(inventoryExit.value);
  const models = providerModelsFromSettings(
    inventoryModels,
    customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  const skills = openCodeSkillsToServerProviderSkills(inventoryExit.value.skills);
  const connectedCount = inventoryExit.value.providerList.connected.length;
  const catalogReady = connectedCount > 0 && inventoryModels.length > 0;
  if (connectedCount > 0 && inventoryModels.length === 0) {
    yield* logDiscoveryFailure({ phase: "inventory", isExternalServer, version });
  }
  return {
    ...buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills,
      slashCommands: openCodeCommandsToServerProviderSlashCommands(inventoryExit.value.commands),
      probe: {
        installed: true,
        version,
        status: catalogReady ? "ready" : "warning",
        auth: {
          status: catalogReady ? "authenticated" : "unknown",
          type: "opencode",
        },
        message:
          connectedCount > 0 && !catalogReady
            ? "OpenCode upstream providers are connected, but it did not list any models yet."
            : connectedCount > 0
              ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
              : isExternalServer
                ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
                : "OpenCode is available, but it did not report any connected upstream providers.",
      },
    }),
    ...installedVersion,
  };
});

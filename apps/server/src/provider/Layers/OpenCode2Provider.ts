import {
  type ModelCapabilities,
  type OpenCode2Settings,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import * as OpenCode2Runtime from "../opencode2Runtime.ts";

const OPENCODE2_PRESENTATION = {
  displayName: "OpenCode 2",
  showInteractionModeToggle: false,
} as const;
const OPENCODE2_PROBE_TIMEOUT = "8 seconds";

const OPENCODE2_AGENT_DESCRIPTOR = {
  id: "agent",
  label: "Agent",
  type: "select",
  options: [
    { id: "build", label: "Build", isDefault: true },
    { id: "plan", label: "Plan" },
  ],
  currentValue: "build",
} as const;

/**
 * Capabilities for models whose variants are unknown (custom models, the
 * fallback catalog). No Reasoning selector: OpenCode 2 rejects a variant the
 * model does not declare, so guessing one breaks every turn.
 */
const DEFAULT_OPENCODE2_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [OPENCODE2_AGENT_DESCRIPTOR],
});

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

/** Reasoning options come from the model's own declared variants. */
function openCode2CapabilitiesForModel(
  model: OpenCode2Runtime.OpenCode2Inventory["models"][number],
): ModelCapabilities {
  if (model.variants.length === 0) {
    return DEFAULT_OPENCODE2_MODEL_CAPABILITIES;
  }
  const defaultVariant = model.variants.includes("medium")
    ? "medium"
    : model.variants.includes("high")
      ? "high"
      : undefined;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: model.variants.map((variant) =>
          variant === defaultVariant
            ? { id: variant, label: titleCaseSlug(variant), isDefault: true as const }
            : { id: variant, label: titleCaseSlug(variant) },
        ),
        ...(defaultVariant ? { currentValue: defaultVariant } : {}),
      },
      OPENCODE2_AGENT_DESCRIPTOR,
    ],
  });
}

function flattenOpenCode2Models(
  inventory: OpenCode2Runtime.OpenCode2Inventory,
): ReadonlyArray<ServerProviderModel> {
  return inventory.models.flatMap((model) => {
    const name = nonEmptyTrimmed(model.name);
    if (!name) return [];
    const subProvider = nonEmptyTrimmed(model.providerId);
    return [
      {
        slug: `${model.providerId}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCode2CapabilitiesForModel(model),
      } satisfies ServerProviderModel,
    ];
  });
}

function openCode2SkillsToServerProviderSkills(
  input: OpenCode2Runtime.OpenCode2Inventory["skills"] | undefined,
): ReadonlyArray<ServerProviderSkill> {
  const skills: Array<ServerProviderSkill> = [];
  for (const skill of input ?? []) {
    const name = nonEmptyTrimmed(skill.name);
    const path = nonEmptyTrimmed(skill.location);
    if (!name || !path) {
      continue;
    }
    const description = nonEmptyTrimmed(skill.description ?? undefined);
    skills.push({
      name,
      path,
      enabled: true,
      ...(description ? { description, shortDescription: description } : {}),
    });
  }
  return skills.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingOpenCode2Provider = (
  openCode2Settings: OpenCode2Settings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: openCode2Settings.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models: providerModelsFromSettings(
        [],
        openCode2Settings.customModels,
        DEFAULT_OPENCODE2_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode 2 provider status has not been checked in this session yet.",
      },
    });
  });

/**
 * Probe the OpenCode 2 server and load inventory from the same connection
 * chat uses. Health comes from the connected server (background service or
 * external URL); no spawned process, no CLI version probe, and no
 * authenticated session is created as a probe side effect.
 */
export const checkOpenCode2ProviderStatus = Effect.fn("checkOpenCode2ProviderStatus")(function* (
  openCode2Settings: OpenCode2Settings,
  cwd: string,
): Effect.fn.Return<ServerProviderDraft, never, OpenCode2Runtime.OpenCode2Runtime> {
  const openCode2Runtime = yield* OpenCode2Runtime.OpenCode2Runtime;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = openCode2Settings.customModels;
  const isExternalServer = openCode2Settings.serverUrl.trim().length > 0;

  // `connect` and `loadInventory` already fail with an `OpenCode2RuntimeError`
  // carrying a human-readable `detail`, so the probe surfaces that directly
  // instead of re-wrapping the failure to recover the message.
  const fallback = (detail: string, connection?: OpenCode2Runtime.OpenCode2Connection) =>
    buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: openCode2Settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE2_MODEL_CAPABILITIES),
      probe: {
        // A reachable server that fails inventory is still installed.
        installed: connection !== undefined,
        version: connection?.version ?? null,
        status: "error",
        auth: { status: "unknown" },
        message: detail,
      },
    });

  if (!openCode2Settings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE2_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode 2 is disabled in T3 Code settings.",
      },
    });
  }

  const connectionResult = yield* openCode2Runtime
    .connect({
      serverUrl: openCode2Settings.serverUrl,
      ...(openCode2Settings.serverPassword
        ? { serverPassword: openCode2Settings.serverPassword }
        : {}),
      // The probe is the first thing a fresh install hits; without the
      // configured binary it would start the SDK's default `opencode`
      // instead of `opencode2` and report the provider unavailable.
      binaryPath: openCode2Settings.binaryPath,
    })
    .pipe(
      Effect.timeoutOrElse({
        duration: OPENCODE2_PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new OpenCode2Runtime.OpenCode2RuntimeError({
              operation: "connect",
              detail: "OpenCode 2 connection probe timed out.",
            }),
          ),
      }),
      Effect.result,
    );
  if (Result.isFailure(connectionResult)) {
    return fallback(connectionResult.failure.detail);
  }
  const connection = connectionResult.success;

  const inventoryResult = yield* openCode2Runtime
    .loadInventory({ client: connection.client, directory: cwd })
    .pipe(
      Effect.timeoutOrElse({
        duration: OPENCODE2_PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new OpenCode2Runtime.OpenCode2RuntimeError({
              operation: "inventory",
              detail: "OpenCode 2 inventory loading timed out.",
            }),
          ),
      }),
      Effect.result,
    );
  if (Result.isFailure(inventoryResult)) {
    return fallback(inventoryResult.failure.detail, connection);
  }
  const inventory = inventoryResult.success;

  const serverModels = flattenOpenCode2Models(inventory);
  const models = providerModelsFromSettings(
    serverModels,
    customModels,
    DEFAULT_OPENCODE2_MODEL_CAPABILITIES,
  );
  const skills = openCode2SkillsToServerProviderSkills(inventory.skills);
  return buildServerProvider({
    presentation: OPENCODE2_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version: connection.version,
      status: models.length > 0 ? "ready" : "warning",
      auth: {
        status: models.length > 0 ? "authenticated" : "unknown",
        type: "opencode",
      },
      // Readiness counts custom models too; the message reports only what
      // the server itself advertises.
      message:
        serverModels.length > 0
          ? `${serverModels.length} model${serverModels.length === 1 ? "" : "s"} available on ${isExternalServer ? "the configured OpenCode 2 server" : "the OpenCode 2 background service"}.`
          : isExternalServer
            ? "Connected to the configured OpenCode 2 server, but it reported no models."
            : "OpenCode 2 is running, but it reported no models.",
    },
  });
});

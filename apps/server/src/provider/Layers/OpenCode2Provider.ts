/**
 * Provider status probe for OpenCode 2.x.
 *
 * 1.x's probe cannot be reused. It parses `<binary> --version` with
 * `parseGenericCliVersion` and enumerates models with `<binary> models
 * --verbose` / `<binary> agent list`, and 2.x breaks both:
 *
 *   - `/api/health` reports the running server's version. Reading it beside
 *     inventory avoids launching the binary a second time for `--version`.
 *   - the inventory subcommands are gone. 2.x's default handler treats the
 *     first argument as a directory to `chdir` into, logs `ENOENT`, and exits
 *     0, so the probe cannot even detect its own failure by exit code.
 *     Inventory moved to `/api/model` and `/api/agent`.
 *
 * @module provider/Layers/OpenCode2Provider
 */
import type { AgentInfoV2, IntegrationInfo, ModelInfo } from "@opencode-ai/sdk-next/v2";
import {
  type ModelCapabilities,
  type OpenCode2Settings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  OPENCODE2_AUTO_AGENT,
  OPENCODE2_DEFAULT_VARIANT,
  isOpenCode2RuntimeError,
  OpenCode2Runtime,
  OpenCode2RuntimeError,
  runOpenCode2Sdk,
} from "../opencode2Runtime.ts";
import {
  buildServerProvider,
  inferOpenCodeDefaultVariant,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

// The Build/Plan toggle maps onto opencode2's native `build`/`plan` primary
// agents (resolveOpenCode2SessionAgent in the adapter), so the toggle shows
// and the Agent descriptor is suppressed unless custom primary agents exist.
const OPENCODE2_PRESENTATION = {
  displayName: "OpenCode 2",
  showInteractionModeToggle: true,
} as const;

/**
 * The `next` build this driver's runtime, event mapping, and route usage were
 * verified against. 2.x has no meaningful semver axis yet — every build on the
 * line is `0.0.0-next-<build>` — so the build number is the only ordering that
 * carries information, and it is only compared when the version still carries
 * a `next` tag. A future stable 2.x is accepted as-is rather than rejected by
 * a rule written for the preview line.
 */
const MINIMUM_OPENCODE2_NEXT_BUILD = 16339;

/**
 * Accepts both the plain `/api/health` value and the `v` prefix emitted by the
 * CLI, which `parseGenericCliVersion` chokes on.
 *
 * @internal exported for tests
 */
export function parseOpenCode2Version(output: string): string | null {
  return output.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/)?.[1] ?? null;
}

/**
 * Build number out of a `0.0.0-next-16339` style version, or `null` when the
 * version is not on the `next` line and the build gate does not apply.
 *
 * @internal exported for tests
 */
export function openCode2NextBuild(version: string): number | null {
  const match = version.match(/-next[.-](\d+)/);
  if (!match) return null;
  const build = Number(match[1]);
  return Number.isFinite(build) ? build : null;
}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  return normalizeProbeMessage(cause.message);
}

function formatOpenCode2ProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  if (isOpenCode2InventorySettlementError(input.cause)) {
    return {
      installed: true,
      message: "OpenCode 2 inventory did not stabilize before the retry limit.",
    };
  }
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";
  const category = isOpenCode2RuntimeError(input.cause) ? input.cause.category : null;

  if (input.isExternalServer) {
    if (category === "external-server-password-required") {
      return {
        installed: true,
        message:
          "The configured OpenCode 2 server requires a password. OpenCode 2 has no unauthenticated mode.",
      };
    }
    if (
      category === "authentication-failed" ||
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message:
          "OpenCode 2 server rejected authentication. Check the server URL and password. OpenCode 2 has no unauthenticated mode.",
      };
    }
    if (
      category === "network-failed" ||
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
        message: `Couldn't reach the configured OpenCode 2 server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }
    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode 2 server.",
    };
  }

  if (category === "binary-not-found" || lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode 2 CLI (`opencode2`) is not installed or not on PATH.",
    };
  }
  if (category === "placeholder-binary" || lower.includes("postinstall")) {
    return {
      installed: false,
      message:
        "The `@opencode-ai/cli` package shipped its placeholder binary: its postinstall script never ran. Reinstall with dependency build scripts enabled.",
    };
  }
  if (category === "quarantined-binary" || lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode 2 binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode2)` to fix this.",
    };
  }
  return {
    installed: true,
    message: detail
      ? `Failed to execute OpenCode 2 CLI health check: ${detail}`
      : "Failed to execute OpenCode 2 CLI health check.",
  };
}

function titleCaseSlug(value: string): string {
  if (value === "opencode") return "OpenCode";
  if (value === "openai") return "OpenAI";
  if (value === "xai") return "xAI";
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return segments.join(" ");
}

const DEFAULT_OPENCODE2_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export interface OpenCode2Inventory {
  readonly models: ReadonlyArray<ModelInfo>;
  readonly agents: ReadonlyArray<AgentInfoV2>;
}

export interface OpenCode2InventorySnapshot extends OpenCode2Inventory {
  readonly connectedIntegrationIDs: ReadonlyArray<string>;
}

interface OpenCode2InventoryResult {
  readonly inventory: OpenCode2InventorySnapshot;
  readonly version: string | null;
}

interface OpenCode2InventorySettlementOptions {
  readonly maxAttempts?: number;
  readonly minimumAttempts?: number;
  readonly quietAttempts?: number;
  readonly retryDelayMs?: number;
}

function openCode2InventoryFingerprint(inventory: OpenCode2InventorySnapshot): string {
  return JSON.stringify({
    agents: inventory.agents
      .map((agent) => [agent.id, agent.name, agent.mode, agent.hidden] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
    connectedIntegrationIDs: inventory.connectedIntegrationIDs.toSorted(),
    models: inventory.models
      .map(
        (model) =>
          [
            model.providerID,
            model.id,
            model.name,
            model.enabled,
            model.variants.map((variant) => variant.id).toSorted(),
          ] as const,
      )
      .toSorted(([leftProvider, leftModel], [rightProvider, rightModel]) =>
        leftProvider === rightProvider
          ? leftModel.localeCompare(rightModel)
          : leftProvider.localeCompare(rightProvider),
      ),
  });
}

function openCode2InventoryIsUsable(inventory: OpenCode2InventorySnapshot): boolean {
  const enabledModels = inventory.models.filter((model) => model.enabled);
  if (enabledModels.length === 0) return false;
  if (inventory.connectedIntegrationIDs.length === 0) return false;
  const modelProviders = new Set(enabledModels.map((model) => model.providerID));
  return inventory.connectedIntegrationIDs.some((integrationID) =>
    modelProviders.has(integrationID),
  );
}

export class OpenCode2InventorySettlementError extends Schema.TaggedErrorClass<OpenCode2InventorySettlementError>()(
  "OpenCode2InventorySettlementError",
  { attempts: Schema.Int },
) {
  override get message(): string {
    return "OpenCode 2 inventory did not stabilize before the retry limit.";
  }
}

export const isOpenCode2InventorySettlementError = Schema.is(OpenCode2InventorySettlementError);

/**
 * A newly spawned 2.x server prints its ready banner before plugin settlement.
 * The first non-empty model snapshot may therefore contain only baseline free
 * models while authenticated integrations are still loading. Observe several
 * snapshots, require a quiet interval after the minimum observation window,
 * and keep waiting until at least one model-bearing connected integration is
 * visible. The attempt cap is the only logged-out completion signal and also
 * bounds broken-plugin and local-only cases.
 *
 * @internal exported for tests
 */
export const settleOpenCode2Inventory = Effect.fn("settleOpenCode2Inventory")(function* <E, R>(
  readInventory: Effect.Effect<OpenCode2InventorySnapshot, E, R>,
  options?: OpenCode2InventorySettlementOptions,
): Effect.fn.Return<OpenCode2InventorySnapshot, E | OpenCode2InventorySettlementError, R> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 51);
  const minimumAttempts = Math.min(maxAttempts, Math.max(1, options?.minimumAttempts ?? 6));
  const quietAttempts = Math.max(1, options?.quietAttempts ?? 2);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 100);
  let inventory = yield* readInventory;
  let fingerprint = openCode2InventoryFingerprint(inventory);
  let consecutiveMatches = 1;
  let settledInventory: OpenCode2InventorySnapshot | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt >= minimumAttempts && consecutiveMatches >= quietAttempts) {
      settledInventory = inventory;
      if (openCode2InventoryIsUsable(inventory)) return inventory;
    }
    if (attempt === maxAttempts) break;
    yield* Effect.sleep(retryDelayMs);
    inventory = yield* readInventory;
    const nextFingerprint = openCode2InventoryFingerprint(inventory);
    consecutiveMatches = nextFingerprint === fingerprint ? consecutiveMatches + 1 : 1;
    fingerprint = nextFingerprint;
  }

  if (settledInventory !== null) return settledInventory;
  return yield* new OpenCode2InventorySettlementError({ attempts: maxAttempts });
});

const OPENCODE2_VARIANT_LABELS: Record<string, string> = {
  xhigh: "Extra High",
};

function inferOpenCode2DefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  return (
    inferOpenCodeDefaultVariant(providerID, variants) ??
    variants.find((variant) => variant === "medium") ??
    variants.find((variant) => variant === "high") ??
    variants.find((variant) => variant !== "none") ??
    variants[0]
  );
}

/**
 * Variants are opencode2's reasoning axis (effort ladders, thinking toggles,
 * budget tiers), synthesized per model from models.dev capability flags.
 */
function openCode2CapabilitiesForModel(input: {
  readonly model: ModelInfo;
  readonly agents: ReadonlyArray<AgentInfoV2>;
}): ModelCapabilities {
  const variantValues = input.model.variants
    .map((variant) => variant.id)
    .filter((variant) => variant !== OPENCODE2_DEFAULT_VARIANT);
  const defaultVariant = inferOpenCode2DefaultVariant(input.model.providerID, variantValues);
  const variantOptions = variantValues.map((variant) => {
    const option = {
      id: variant,
      label: OPENCODE2_VARIANT_LABELS[variant] ?? titleCaseSlug(variant),
    };
    return variant === defaultVariant ? { ...option, isDefault: true as const } : option;
  });
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  // The standalone Build/Plan interaction-mode toggle owns both native agents.
  // Never expose either one through model options, including while startup has
  // reported only half of the pair. Custom agents remain available behind an
  // Auto sentinel that defers to the toggle.
  const customAgents = primaryAgents.filter(
    (agent) => agent.id !== "build" && agent.id !== "plan" && agent.id !== OPENCODE2_AUTO_AGENT,
  );
  const hasNativeAgentPair =
    primaryAgents.some((agent) => agent.id === "build") &&
    primaryAgents.some((agent) => agent.id === "plan");
  const agentOptions =
    !hasNativeAgentPair || customAgents.length === 0
      ? []
      : [
          { id: OPENCODE2_AUTO_AGENT, label: "Auto (Build/Plan)" },
          ...customAgents.map((agent) => ({ id: agent.id, label: titleCaseSlug(agent.name) })),
        ];
  const defaultVariantSelection = defaultVariant ? { currentValue: defaultVariant } : {};
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Reasoning",
              type: "select" as const,
              options: variantOptions,
              ...defaultVariantSelection,
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
              currentValue: OPENCODE2_AUTO_AGENT,
            },
          ]
        : []),
    ],
  });
}

export function flattenOpenCode2Models(
  inventory: OpenCode2Inventory,
): ReadonlyArray<ServerProviderModel> {
  const models: Array<ServerProviderModel> = [];
  for (const model of inventory.models) {
    if (!model.enabled) continue;
    const name = nonEmptyTrimmed(model.name);
    if (!name) continue;
    models.push({
      slug: `${model.providerID}/${model.id}`,
      name,
      subProvider: titleCaseSlug(model.providerID),
      isCustom: false,
      capabilities: openCode2CapabilitiesForModel({ model, agents: inventory.agents }),
    });
  }
  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * Reads the 2.x inventory and version over HTTP, spawning a server when none
 * is configured. `/api/model` and `/api/agent` replaced the inventory CLI
 * subcommands, while `/api/health` avoids a second binary launch for version.
 */
const loadOpenCode2Inventory = (input: {
  readonly runtime: OpenCode2Runtime["Service"];
  readonly settings: OpenCode2Settings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<
  OpenCode2InventoryResult,
  OpenCode2InventorySettlementError | OpenCode2RuntimeError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* input.runtime.connectToOpenCode2Server({
        binaryPath: input.settings.binaryPath,
        serverUrl: input.settings.serverUrl,
        serverPassword: input.settings.serverPassword,
        environment: input.environment,
      });
      const client = input.runtime.createOpenCode2SdkClient({
        baseUrl: server.url,
        directory: input.cwd,
        serverPassword: server.password,
      });
      const location = { directory: input.cwd };
      const [inventory, healthResponse] = yield* Effect.all(
        [
          settleOpenCode2Inventory(
            Effect.gen(function* () {
              const [modelResponse, agentResponse, integrationResponse] = yield* Effect.all(
                [
                  runOpenCode2Sdk("model.list", () => client.v2.model.list({ location })),
                  runOpenCode2Sdk("agent.list", () => client.v2.agent.list({ location })),
                  runOpenCode2Sdk("integration.list", () =>
                    client.v2.integration.list({ location }),
                  ),
                ],
                { concurrency: "unbounded" },
              );
              return {
                models: modelResponse.data?.data ?? [],
                agents: agentResponse.data?.data ?? [],
                connectedIntegrationIDs: (integrationResponse.data?.data ?? [])
                  .filter((integration: IntegrationInfo) => integration.connections.length > 0)
                  .map((integration: IntegrationInfo) => integration.id),
              } satisfies OpenCode2InventorySnapshot;
            }),
          ),
          runOpenCode2Sdk("health.get", () => client.v2.health.get()),
        ],
        { concurrency: "unbounded" },
      );
      return {
        inventory,
        version: parseOpenCode2Version(healthResponse.data?.version ?? ""),
      };
    }),
  );

export const makePendingOpenCode2Provider = (
  settings: OpenCode2Settings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      settings.customModels,
      DEFAULT_OPENCODE2_MODEL_CAPABILITIES,
    );
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "OpenCode 2 provider status has not been checked in this session yet."
          : "OpenCode 2 is disabled in T3 Code settings.",
      },
    });
  });

export const checkOpenCode2ProviderStatus = Effect.fn("checkOpenCode2ProviderStatus")(function* (
  settings: OpenCode2Settings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, OpenCode2Runtime> {
  const runtime = yield* OpenCode2Runtime;
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = settings.customModels;
  const isExternalServer = settings.serverUrl.trim().length > 0;

  const draft = (input: {
    readonly installed: boolean;
    readonly version: string | null;
    readonly status: "ready" | "warning" | "error";
    readonly message: string;
    readonly models?: ReadonlyArray<ServerProviderModel>;
    readonly authenticated?: boolean;
  }) =>
    buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        input.models ?? [],
        customModels,
        DEFAULT_OPENCODE2_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: input.installed,
        version: input.version,
        status: input.status,
        auth: input.authenticated
          ? { status: "authenticated", type: "opencode" }
          : { status: "unknown" },
        message: input.message,
      },
    });

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatOpenCode2ProbeError({
      cause,
      isExternalServer,
      serverUrl: settings.serverUrl,
    });
    return draft({
      installed: failure.installed,
      version,
      status: "error",
      message: failure.message,
    });
  };

  if (!settings.enabled) {
    return draft({
      installed: false,
      version: null,
      status: "warning",
      message: isExternalServer
        ? "OpenCode 2 is disabled in T3 Code settings. A server URL is configured."
        : "OpenCode 2 is disabled in T3 Code settings.",
    });
  }

  const inventoryExit = yield* Effect.exit(
    loadOpenCode2Inventory({
      runtime,
      settings,
      cwd,
      environment: resolvedEnvironment,
    }),
  );

  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause));
  }

  const version = inventoryExit.value.version;
  if (version === null) {
    return fallback(new Error("Unable to determine OpenCode 2 version from `/api/health`."));
  }
  const build = openCode2NextBuild(version);
  if (build !== null && build < MINIMUM_OPENCODE2_NEXT_BUILD) {
    return draft({
      installed: true,
      version,
      status: "error",
      message: isExternalServer
        ? `The configured OpenCode 2 server reports ${version}, which is older than the verified build next-${MINIMUM_OPENCODE2_NEXT_BUILD}. Upgrade that server to next-${MINIMUM_OPENCODE2_NEXT_BUILD} or newer.`
        : `OpenCode 2 ${version} is older than the verified build next-${MINIMUM_OPENCODE2_NEXT_BUILD}. Upgrade with \`npm install -g @opencode-ai/cli@next\`.`,
    });
  }

  const models = flattenOpenCode2Models(inventoryExit.value.inventory);
  const connectedIntegrationCount = inventoryExit.value.inventory.connectedIntegrationIDs.length;
  let message = "Connected to OpenCode 2, but it did not report any enabled models.";
  if (models.length > 0) {
    const modelLabel = models.length === 1 ? "model" : "models";
    const sourceLabel = isExternalServer ? "the configured OpenCode 2 server" : "OpenCode 2";
    let integrationLabel = "without a connected authenticated integration";
    if (connectedIntegrationCount > 0) {
      const integrationNoun = connectedIntegrationCount === 1 ? "integration" : "integrations";
      integrationLabel = `with ${connectedIntegrationCount} connected ${integrationNoun}`;
    }
    message = `${models.length} ${modelLabel} available through ${sourceLabel} ${integrationLabel}.`;
  }
  return draft({
    installed: true,
    version,
    status: models.length > 0 ? "ready" : "warning",
    authenticated: connectedIntegrationCount > 0,
    models,
    message,
  });
});

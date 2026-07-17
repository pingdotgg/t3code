import {
  ProviderDriverKind,
  type ModelCapabilities,
  type KiloSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { KiloRuntime, kiloRuntimeErrorDetail, type KiloInventory } from "../kiloRuntime.ts";
import type { ProviderListResponse } from "@kilocode/sdk/v2";

const PROVIDER = ProviderDriverKind.make("kilo");
const KILO_PRESENTATION = {
  displayName: "Kilo",
  showInteractionModeToggle: true,
} as const;

class KiloProbeError extends Data.TaggedError("KiloProbeError")<{
  readonly cause: unknown;
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
  if (cause instanceof KiloProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatKiloProbeError(input: { readonly cause: unknown }): {
  readonly installed: boolean;
  readonly message: string;
} {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "Kilo CLI (`kilo`) is not installed or not on PATH.",
    };
  }

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return {
      installed: true,
      message:
        "Kilo server rejected authentication. Restart T3 Code or check the Kilo CLI install.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the Kilo binary (quarantine). Run `xattr -d com.apple.quarantine $(which kilo)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the Kilo process due to an invalid code signature. The binary may be corrupted — try reinstalling Kilo.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute Kilo CLI health check: ${detail}`
      : "Failed to execute Kilo CLI health check.",
  };
}

const DEFAULT_KILO_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
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
  if (providerID === "openai" || providerID === "opencode" || providerID === "kilo") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function kiloCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  // v1: hide agents in model capabilities; default agent is fixed to `code`.
  return createModelCapabilities({
    optionDescriptors:
      variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : [],
  });
}

export function flattenKiloModels(input: KiloInventory): ReadonlyArray<ServerProviderModel> {
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
        capabilities: kiloCapabilitiesForModel({
          providerID: provider.id,
          model,
        }),
      });
    }
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingKiloProvider = (
  kiloSettings: KiloSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      kiloSettings.customModels,
      DEFAULT_KILO_MODEL_CAPABILITIES,
    );

    if (!kiloSettings.enabled) {
      return buildServerProvider({
        presentation: KILO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kilo is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kilo provider status has not been checked in this session yet.",
      },
    });
  });

export const checkKiloProviderStatus = Effect.fn("checkKiloProviderStatus")(function* (
  kiloSettings: KiloSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, KiloRuntime> {
  const kiloRuntime = yield* KiloRuntime;
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = kiloSettings.customModels;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatKiloProbeError({ cause });
    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: kiloSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_KILO_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!kiloSettings.enabled) {
    return buildServerProvider({
      presentation: KILO_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_KILO_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kilo is disabled in T3 Code settings.",
      },
    });
  }

  const versionExit = yield* Effect.exit(
    kiloRuntime
      .runKiloCommand({
        binaryPath: kiloSettings.binaryPath,
        args: ["--version"],
        environment: resolvedEnvironment,
      })
      .pipe(
        Effect.mapError(
          (cause) => new KiloProbeError({ cause, detail: kiloRuntimeErrorDetail(cause) }),
        ),
      ),
  );
  if (versionExit._tag === "Failure") {
    return fallback(Cause.squash(versionExit.cause));
  }
  const version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* kiloRuntime.connectToKiloServer({
          binaryPath: kiloSettings.binaryPath,
          environment: resolvedEnvironment,
        });
        return yield* kiloRuntime.loadKiloInventory(
          kiloRuntime.createKiloSdkClient({
            baseUrl: server.url,
            directory: cwd,
            serverPassword: server.password,
          }),
        );
      }).pipe(
        Effect.mapError(
          (cause) => new KiloProbeError({ cause, detail: kiloRuntimeErrorDetail(cause) }),
        ),
      ),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  const models = providerModelsFromSettings(
    flattenKiloModels(inventoryExit.value),
    PROVIDER,
    customModels,
    DEFAULT_KILO_MODEL_CAPABILITIES,
  );
  const connectedCount = inventoryExit.value.providerList.connected.length;
  return buildServerProvider({
    presentation: KILO_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "kilo",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through Kilo.`
          : "Kilo is available, but it did not report any connected upstream providers.",
    },
  });
});

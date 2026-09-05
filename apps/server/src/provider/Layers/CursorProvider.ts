import type { SDKModel, SDKUser } from "@cursor/sdk";
import type {
  CursorSettings,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { cursorSdkParameterPriority, cursorSdkProviderOptionId } from "../cursorSdkModel.ts";
import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { CursorSdkCatalog } from "./CursorSdkCatalog.ts";

const CURSOR_PRESENTATION = {
  displayName: "Cursor",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CURSOR_SDK_CATALOG_TIMEOUT_MS = 15_000;

export function buildInitialCursorProviderSnapshot(
  cursorSettings: CursorSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = getCursorFallbackModels(cursorSettings);

    if (!cursorSettings.enabled) {
      return buildServerProvider({
        presentation: CURSOR_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Cursor SDK availability...",
      },
    });
  });
}

export function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], cursorSettings.customModels, EMPTY_CAPABILITIES);
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function cursorSdkDefaultParameterValue(model: SDKModel, parameterId: string): string | undefined {
  return model.variants
    ?.find((variant) => variant.isDefault)
    ?.params.find((parameter) => parameter.id === parameterId)?.value;
}

export function buildCursorCapabilitiesFromSdkModel(model: SDKModel): ModelCapabilities {
  const seen = new Set<string>();
  const optionDescriptors: Array<ProviderOptionDescriptor> = [];
  const parameters = (model.parameters ?? [])
    .map((parameter, index) => ({ parameter, index }))
    .toSorted(
      (left, right) =>
        cursorSdkParameterPriority(left.parameter.id) -
          cursorSdkParameterPriority(right.parameter.id) || left.index - right.index,
    );
  for (const { parameter } of parameters) {
    const nativeId = parameter.id.trim();
    const id = cursorSdkProviderOptionId(nativeId);
    if (!nativeId || !id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const values = parameter.values.flatMap((entry) => {
      const value = entry.value.trim();
      if (!value) {
        return [];
      }
      return [
        {
          value,
          label: entry.displayName?.trim() || value,
        },
      ];
    });
    if (values.length === 0) {
      continue;
    }

    const label = parameter.displayName?.trim() || toTitleCaseWords(id);
    const defaultValue = cursorSdkDefaultParameterValue(model, nativeId);
    const normalizedValues = new Set(values.map((entry) => entry.value.toLowerCase()));
    if (values.length === 2 && normalizedValues.has("true") && normalizedValues.has("false")) {
      if (defaultValue === "true" || defaultValue === "false") {
        optionDescriptors.push(
          buildBooleanOptionDescriptor({
            id,
            label,
            currentValue: defaultValue === "true",
          }),
        );
      } else {
        optionDescriptors.push(buildBooleanOptionDescriptor({ id, label }));
      }
      continue;
    }

    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id,
        label,
        options: values.map((entry) => ({
          ...entry,
          ...(entry.value === defaultValue ? { isDefault: true } : {}),
        })),
      }),
    );
  }

  return createModelCapabilities({ optionDescriptors });
}

export function buildCursorDiscoveredModelsFromSdk(
  models: ReadonlyArray<SDKModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const slug = model.id.trim();
    const name = model.displayName.trim();
    if (!slug || !name || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name,
        isCustom: false,
        capabilities: buildCursorCapabilitiesFromSdkModel(model),
      } satisfies ServerProviderModel,
    ];
  });
}

function cursorSdkAuth(user: SDKUser): ServerProviderAuth {
  const email = user.userEmail?.trim();
  const apiKeyName = user.apiKeyName.trim();
  return {
    status: "authenticated",
    type: "api-key",
    label: apiKeyName ? `Cursor API key (${apiKeyName})` : "Cursor API key",
    ...(email ? { email } : {}),
  };
}

interface CursorProviderProbeResult {
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

export function buildCursorProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly cursorSettings: CursorSettings;
  readonly parsed: CursorProviderProbeResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: CURSOR_PRESENTATION,
    enabled: input.cursorSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      input.cursorSettings.customModels,
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

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, CursorSdkCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = getCursorFallbackModels(cursorSettings);

  if (!cursorSettings.enabled) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in T3 Code settings.",
      },
    });
  }

  const sdkApiKey = environment?.CURSOR_API_KEY?.trim();
  if (!sdkApiKey) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
      },
    });
  }

  const sdkCatalog = yield* CursorSdkCatalog;
  const catalogResult = yield* sdkCatalog
    .read(sdkApiKey)
    .pipe(Effect.timeoutOption(CURSOR_SDK_CATALOG_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(catalogResult)) {
    yield* Effect.logWarning("Cursor SDK catalog probe failed", {
      cause: catalogResult.failure.cause,
    });
    const authenticationFailure = catalogResult.failure.authenticationFailure;
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: authenticationFailure ? "unauthenticated" : "unknown" },
        message: authenticationFailure
          ? "Cursor SDK authentication failed. Check CURSOR_API_KEY."
          : "Cursor SDK catalog request failed. Check server logs for details.",
      },
    });
  }

  if (Option.isNone(catalogResult.success)) {
    return buildServerProvider({
      presentation: CURSOR_PRESENTATION,
      enabled: cursorSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Cursor SDK catalog request timed out after ${CURSOR_SDK_CATALOG_TIMEOUT_MS}ms.`,
      },
    });
  }

  const snapshot = catalogResult.success.value;
  const discoveredModels = buildCursorDiscoveredModelsFromSdk(snapshot.models);
  return buildCursorProviderSnapshot({
    checkedAt,
    cursorSettings,
    parsed: {
      version: null,
      status: "ready",
      auth: cursorSdkAuth(snapshot.user),
    },
    discoveredModels,
    ...(discoveredModels.length === 0
      ? { discoveryWarning: "Cursor SDK model discovery returned no built-in models." }
      : {}),
  });
});

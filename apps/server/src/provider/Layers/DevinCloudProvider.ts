import {
  type DevinCloudSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { makeDevinCloudApi } from "../DevinCloudApi.ts";
import { resolveDevinCloudCredentials } from "../DevinCloudCredentials.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Devin Cloud",
  badgeLabel: "Cloud",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

// Devin Cloud's model choice is the API's `devin_mode` on session creation:
// it cannot change mid-session, which is why the presentation sets
// `requiresNewThreadForModelChange`. Preview modes (lite/ultra/fusion) are
// feature-flagged per organization; the API rejects unavailable ones.
export const DEVIN_CLOUD_MODES = ["normal", "fast", "lite", "ultra", "fusion"] as const;
export type DevinCloudMode = (typeof DEVIN_CLOUD_MODES)[number];
export const DEVIN_CLOUD_DEFAULT_MODEL = "devin-normal";

const MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_CLOUD_DEFAULT_MODEL,
    name: "Devin",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  { slug: "devin-fast", name: "Devin Fast", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "devin-lite", name: "Devin Lite", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "devin-ultra", name: "Devin Ultra", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  {
    slug: "devin-fusion",
    name: "Devin Fusion",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Maps a Devin Cloud model slug ("devin-fast") to the API's `devin_mode`
 * value. Unknown slugs, including the legacy "devin-cloud", return undefined
 * so the session falls back to the organization's default mode.
 */
export function devinCloudModeFromModel(model: string | undefined): DevinCloudMode | undefined {
  if (!model?.startsWith("devin-")) return undefined;
  const mode = model.slice("devin-".length);
  return (DEVIN_CLOUD_MODES as ReadonlyArray<string>).includes(mode)
    ? (mode as DevinCloudMode)
    : undefined;
}

export function buildInitialDevinCloudProviderSnapshot(
  settings: DevinCloudSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return buildSnapshot(settings, checkedAt, "warning", "unknown", "Devin Cloud is disabled.");
    }
    return buildSnapshot(
      settings,
      checkedAt,
      "warning",
      "unknown",
      "Checking Devin Cloud credentials...",
    );
  });
}

export const checkDevinCloudProviderStatus = Effect.fn("checkDevinCloudProviderStatus")(function* (
  settings: DevinCloudSettings,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return yield* buildInitialDevinCloudProviderSnapshot(settings);
  }
  const resolved = yield* resolveDevinCloudCredentials(settings).pipe(Effect.result);
  if (Result.isFailure(resolved)) {
    return buildSnapshot(settings, checkedAt, "error", "unauthenticated", resolved.failure.message);
  }
  if (Option.isNone(resolved.success)) {
    return buildSnapshot(
      settings,
      checkedAt,
      "warning",
      "unauthenticated",
      "Add a Devin service-user API key and organization ID, or sign in with the Devin CLI on this machine.",
    );
  }
  const credentials = resolved.success.value;
  const result = yield* (yield* makeDevinCloudApi(credentials.settings)).getSelf.pipe(
    Effect.result,
  );
  if (result._tag === "Success") {
    return buildSnapshot(
      settings,
      checkedAt,
      "ready",
      "authenticated",
      credentials.source === "devin-cli"
        ? "Connected to Devin Cloud using the Devin CLI sign-in."
        : "Connected to Devin Cloud.",
    );
  }
  return buildSnapshot(settings, checkedAt, "error", "unauthenticated", result.failure.message);
});

function buildSnapshot(
  settings: DevinCloudSettings,
  checkedAt: string,
  status: "ready" | "warning" | "error",
  authStatus: "authenticated" | "unauthenticated" | "unknown",
  message: string,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: MODELS,
    probe: {
      installed: true,
      version: null,
      status,
      auth: { status: authStatus },
      message,
    },
  });
}

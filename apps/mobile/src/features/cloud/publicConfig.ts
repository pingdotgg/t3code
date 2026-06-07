import Constants from "expo-constants";
import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

type ExpoExtra = Readonly<Record<string, unknown>> | undefined;

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  const clerk = extra?.clerk as
    | { readonly publishableKey?: unknown; readonly jwtTemplate?: unknown }
    | undefined;
  const relay = extra?.relay as { readonly url?: unknown } | undefined;
  const observability = extra?.observability as
    | {
        readonly tracesUrl?: unknown;
        readonly tracesDataset?: unknown;
        readonly tracesToken?: unknown;
      }
    | undefined;

  return {
    clerkPublishableKey: trimNonEmpty(clerk?.publishableKey),
    clerkJwtTemplate: trimNonEmpty(clerk?.jwtTemplate),
    relayUrl: normalizeSecureRelayUrl(trimNonEmpty(relay?.url) ?? ""),
    observability: {
      tracesUrl: normalizeSecureUrl(
        observability?.tracesUrl ?? process.env.EXPO_PUBLIC_T3CODE_MOBILE_OTLP_TRACES_URL,
      ),
      tracesDataset: trimNonEmpty(
        observability?.tracesDataset ?? process.env.EXPO_PUBLIC_T3CODE_MOBILE_OTLP_TRACES_DATASET,
      ),
      tracesToken: trimNonEmpty(
        observability?.tracesToken ?? process.env.EXPO_PUBLIC_T3CODE_MOBILE_OTLP_TRACES_TOKEN,
      ),
    },
  } satisfies CloudPublicConfig;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.clerkPublishableKey && config.clerkJwtTemplate && config.relayUrl);
}

type MobileTracingPublicConfig = CloudPublicConfig & {
  readonly observability: {
    readonly tracesUrl: string;
    readonly tracesDataset: string;
    readonly tracesToken: string;
  };
};

export function hasMobileTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is MobileTracingPublicConfig {
  return Boolean(
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new Error("T3CODE_CLERK_JWT_TEMPLATE is not configured.");
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}

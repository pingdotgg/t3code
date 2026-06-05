import Constants from "expo-constants";
import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

type ExpoExtra = Readonly<Record<string, unknown>> | undefined;

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
}

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  const clerk = extra?.clerk as
    | { readonly publishableKey?: unknown; readonly jwtTemplate?: unknown }
    | undefined;
  const relay = extra?.relay as { readonly url?: unknown } | undefined;

  return {
    clerkPublishableKey: trimNonEmpty(clerk?.publishableKey),
    clerkJwtTemplate: trimNonEmpty(clerk?.jwtTemplate),
    relayUrl: normalizeSecureRelayUrl(trimNonEmpty(relay?.url) ?? ""),
  } satisfies CloudPublicConfig;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.clerkPublishableKey && config.clerkJwtTemplate && config.relayUrl);
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new Error("T3CODE_CLERK_JWT_TEMPLATE is not configured.");
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}

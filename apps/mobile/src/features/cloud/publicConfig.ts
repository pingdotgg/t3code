import Constants from "expo-constants";

type ExpoExtra = Readonly<Record<string, unknown>> | undefined;

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly relayUrl: string | null;
}

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  const clerk = extra?.clerk as { readonly publishableKey?: unknown } | undefined;
  const relay = extra?.relay as { readonly url?: unknown } | undefined;

  return {
    clerkPublishableKey: trimNonEmpty(clerk?.publishableKey),
    relayUrl: trimNonEmpty(relay?.url)?.replace(/\/+$/u, "") ?? null,
  } satisfies CloudPublicConfig;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.clerkPublishableKey && config.relayUrl);
}

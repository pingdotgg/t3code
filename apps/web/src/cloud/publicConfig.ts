export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly relayUrl: string | null;
}

function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    relayUrl:
      trimNonEmpty(import.meta.env.VITE_T3_RELAY_URL as string | undefined)?.replace(/\/+$/u, "") ??
      null,
  };
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.clerkPublishableKey && config.relayUrl);
}

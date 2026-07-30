import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedErrorClass<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly clerkCliOAuthClientId: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export type CloudPublicConfigKey =
  | "T3CODE_CLERK_PUBLISHABLE_KEY"
  | "T3CODE_CLERK_JWT_TEMPLATE"
  | "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID"
  | "T3CODE_RELAY_URL";

export interface CloudPublicConfigState {
  readonly configured: boolean;
  readonly missingKeys: readonly CloudPublicConfigKey[];
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    clerkCliOAuthClientId: trimNonEmpty(
      import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID as string | undefined,
    ),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

export function resolveRelayTracingConfig() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  return resolveCloudPublicConfigState().configured;
}

export function resolveCloudPublicConfigState(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): CloudPublicConfigState {
  const missingKeys: CloudPublicConfigKey[] = [];
  if (!config.clerkPublishableKey) {
    missingKeys.push("T3CODE_CLERK_PUBLISHABLE_KEY");
  }
  if (!config.clerkJwtTemplate) {
    missingKeys.push("T3CODE_CLERK_JWT_TEMPLATE");
  }
  if (!config.clerkCliOAuthClientId) {
    missingKeys.push("T3CODE_CLERK_CLI_OAUTH_CLIENT_ID");
  }
  if (!config.relayUrl) {
    missingKeys.push("T3CODE_RELAY_URL");
  }
  return {
    configured: missingKeys.length === 0,
    missingKeys,
  };
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}

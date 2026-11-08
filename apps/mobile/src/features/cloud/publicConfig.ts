import {
  encodeSelfHostedRelay,
  parseStoredSelfHostedRelay,
  SELF_HOSTED_RELAY_STORAGE_KEY,
  type SelfHostedRelay,
} from "@t3tools/client-runtime/relay/self-hosted";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
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
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly oidc: {
    readonly issuer: string | null;
    readonly clientId: string | null;
  };
  readonly relay: {
    readonly url: string | null;
    /** False for a relay that cannot provision tunnels, so links use the environment's own address. */
    readonly managedTunnels: boolean;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

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

let selfHostedRelay: SelfHostedRelay | null | undefined;

/** The relay the user chose in settings; it replaces the build's T3 Connect until cleared. */
export function readSelfHostedRelay(): SelfHostedRelay | null {
  if (selfHostedRelay !== undefined) return selfHostedRelay;
  try {
    selfHostedRelay = parseStoredSelfHostedRelay(
      SecureStore.getItem(SELF_HOSTED_RELAY_STORAGE_KEY),
    );
  } catch {
    selfHostedRelay = null;
  }
  return selfHostedRelay;
}

/** Sign-in is wired once at startup, so callers reload the app after a change. */
export async function saveSelfHostedRelay(relay: SelfHostedRelay | null): Promise<void> {
  if (relay === null) await SecureStore.deleteItemAsync(SELF_HOSTED_RELAY_STORAGE_KEY);
  else await SecureStore.setItemAsync(SELF_HOSTED_RELAY_STORAGE_KEY, encodeSelfHostedRelay(relay));
  selfHostedRelay = relay;
}

export function resolveCloudPublicConfig(
  extra: ExpoExtra = Constants.expoConfig?.extra,
  selfHosted: SelfHostedRelay | null = readSelfHostedRelay(),
): CloudPublicConfig {
  if (selfHosted !== null) {
    return {
      clerk: { publishableKey: null, jwtTemplate: null },
      oidc: { issuer: selfHosted.oidcIssuer, clientId: selfHosted.oidcClientId },
      relay: { url: selfHosted.relayUrl, managedTunnels: selfHosted.managedTunnels },
      // The build's relay telemetry belongs to its own T3 Connect, not to this relay.
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    };
  }
  const oidcIssuer = trimNonEmpty(extra?.oidc?.issuer);
  return {
    clerk: {
      publishableKey: trimNonEmpty(extra?.clerk?.publishableKey),
      jwtTemplate: trimNonEmpty(extra?.clerk?.jwtTemplate),
    },
    oidc: {
      issuer: oidcIssuer,
      clientId: trimNonEmpty(extra?.oidc?.clientId),
    },
    relay: {
      url: normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? ""),
      // A build configured for OIDC targets a self-hosted relay, which has no managed tunnels.
      managedTunnels: oidcIssuer === null,
    },
    observability: {
      tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
      tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
      tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
    },
  };
}

/** An OpenID Connect provider takes the place of Clerk when the build configures one. */
export function cloudAuthProvider(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): "oidc" | "clerk" | null {
  if (!config.relay.url) return null;
  if (config.oidc.issuer && config.oidc.clientId) return "oidc";
  return config.clerk.publishableKey && config.clerk.jwtTemplate ? "clerk" : null;
}

export function hasCloudPublicConfig(): boolean {
  return cloudAuthProvider() !== null;
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is TracingPublicConfig {
  return Boolean(
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}

export function resolveRelayClerkTokenOptions() {
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  if (!jwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(jwtTemplate);
}

import {
  clerkFrontendApiHostnameFromPublishableKey,
  relayClerkTokenOptions,
} from "@t3tools/shared/relayAuth";
import {
  encodeSelfHostedRelay,
  parseStoredSelfHostedRelay,
  SELF_HOSTED_RELAY_STORAGE_KEY,
  type SelfHostedRelay,
} from "@t3tools/client-runtime/relay/self-hosted";
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
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly oidcIssuer: string | null;
  readonly oidcClientId: string | null;
  readonly relayUrl: string | null;
  /** False for a relay that cannot provision tunnels, so links use the environment's own address. */
  readonly managedTunnels: boolean;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
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

let selfHostedRelay: SelfHostedRelay | null | undefined;

/** The relay the user chose in settings; it replaces the build's T3 Connect until cleared. */
export function readSelfHostedRelay(): SelfHostedRelay | null {
  if (selfHostedRelay !== undefined) return selfHostedRelay;
  try {
    selfHostedRelay = parseStoredSelfHostedRelay(
      window.localStorage.getItem(SELF_HOSTED_RELAY_STORAGE_KEY),
    );
  } catch {
    selfHostedRelay = null;
  }
  return selfHostedRelay;
}

/** Sign-in is wired once at startup, so callers reload the page after a change. */
export function saveSelfHostedRelay(relay: SelfHostedRelay | null): void {
  if (relay === null) window.localStorage.removeItem(SELF_HOSTED_RELAY_STORAGE_KEY);
  else window.localStorage.setItem(SELF_HOSTED_RELAY_STORAGE_KEY, encodeSelfHostedRelay(relay));
  selfHostedRelay = relay;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  const selfHosted = typeof window === "undefined" ? null : readSelfHostedRelay();
  if (selfHosted !== null) {
    return {
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      oidcIssuer: selfHosted.oidcIssuer,
      oidcClientId: selfHosted.oidcClientId,
      relayUrl: selfHosted.relayUrl,
      managedTunnels: selfHosted.managedTunnels,
      // The build's relay telemetry belongs to its own T3 Connect, not to this relay.
      relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    };
  }
  const oidcIssuer = trimNonEmpty(import.meta.env.VITE_OIDC_ISSUER as string | undefined);
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    oidcIssuer,
    oidcClientId: trimNonEmpty(import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    // A build configured for OIDC targets a self-hosted relay, which has no managed tunnels.
    managedTunnels: oidcIssuer === null,
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
  // The relay exporter is created during module initialization, so this must be synchronous.
  if (typeof window !== "undefined" && window.desktopBridge?.getRelayTelemetryEnabled() === false) {
    return null;
  }
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export interface OidcPublicConfig {
  readonly issuer: string;
  readonly clientId: string;
}

/** An OpenID Connect provider takes the place of Clerk when the build configures one. */
export function resolveOidcPublicConfig(): OidcPublicConfig | null {
  const { oidcIssuer, oidcClientId, relayUrl } = resolveCloudPublicConfig();
  return oidcIssuer && oidcClientId && relayUrl
    ? { issuer: oidcIssuer, clientId: oidcClientId }
    : null;
}

export function cloudAuthProvider(): "oidc" | "clerk" | null {
  if (resolveOidcPublicConfig() !== null) return "oidc";
  return hasClerkPublicConfig() ? "clerk" : null;
}

export function hasCloudPublicConfig(): boolean {
  return cloudAuthProvider() !== null;
}

function hasClerkPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  if (!config.clerkPublishableKey || !config.clerkJwtTemplate || !config.relayUrl) {
    return false;
  }

  // Electron has its own auth runtime; development keys also support private browser origins.
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !config.clerkPublishableKey.startsWith("pk_live_")
  ) {
    return true;
  }

  try {
    // Custom Frontend API hosts use clerk.<production domain>.
    const domain = clerkFrontendApiHostnameFromPublishableKey(config.clerkPublishableKey).replace(
      /^clerk\./u,
      "",
    );
    const { hostname, protocol, port } = window.location;
    return (
      protocol === "https:" &&
      port === "" &&
      (hostname === domain || hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}

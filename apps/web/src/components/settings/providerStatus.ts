import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  neutral: {
    dot: "bg-muted-foreground",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/** The server names a custom endpoint in English; other auth labels are product or plan names. */
export function providerAuthLabel(
  auth: Pick<ServerProvider["auth"], "label" | "type">,
  resolve: MessageResolver = m,
): string | undefined {
  if (auth.type === "customEndpoint") return resolve(msg("Custom API endpoint"));
  return auth.label ?? auth.type;
}

// Antigravity's local health check verifies installation, not Google sign-in.
// API-key and Agent Platform warnings still need attention.
function isAntigravitySignInUnchecked(provider: ServerProvider): boolean {
  return (
    provider.driver === "antigravity" &&
    provider.installed &&
    provider.status === "warning" &&
    provider.auth.status === "unknown" &&
    (provider.auth.type === undefined ||
      provider.auth.type === "oauth-personal" ||
      provider.auth.type === "oauth-business")
  );
}

export function getProviderStatusKey(provider: ServerProvider | undefined): ProviderStatusKey {
  if (provider && !provider.enabled) return "disabled";
  if (provider && isAntigravitySignInUnchecked(provider)) return "neutral";
  return provider?.status ?? "warning";
}

export function getProviderSummary(
  provider: ServerProvider | undefined,
  resolve: MessageResolver = m,
) {
  if (!provider) {
    return {
      headline: resolve(msg("Checking provider status")),
      detail: resolve(
        msg("Waiting for the server to report installation and authentication details."),
      ),
    };
  }
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: resolve(msg("Disabled", { $context: "provider status" })),
      detail:
        provider.message ??
        resolve(msg("This provider is installed but disabled for new sessions in T3 Code.")),
    };
  }
  if (!provider.installed) {
    return {
      headline: resolve(msg("Not found", { $context: "provider status, CLI is missing" })),
      detail: provider.message ?? resolve(msg("CLI not detected on PATH.")),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const authLabel = providerAuthLabel(provider.auth, resolve);
    return {
      headline: authLabel
        ? resolve(msg("Not authenticated · {method}", { method: authLabel }))
        : resolve(msg("Not authenticated")),
      detail: provider.message ?? null,
    };
  }
  if (isAntigravitySignInUnchecked(provider)) {
    return {
      headline: resolve(msg("Installed · Sign-in not checked")),
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: resolve(msg("Needs attention")),
      detail:
        provider.message ??
        resolve(msg("The provider is installed, but the server could not fully verify it.")),
    };
  }
  if (provider.status === "error") {
    return {
      headline: resolve(msg("Unavailable", { $context: "provider status" })),
      detail: provider.message ?? resolve(msg("The provider failed its startup checks.")),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = providerAuthLabel(provider.auth, resolve);
    return {
      headline: authLabel
        ? resolve(msg("Authenticated · {method}", { method: authLabel }))
        : resolve(msg("Authenticated")),
      detail: provider.message ?? null,
    };
  }
  return {
    headline: resolve(msg("Available", { $context: "provider status" })),
    detail: provider.message ?? null,
  };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity;
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ""}`;
  }
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES = {
  graceful: msg("Limited support"),
  unsupported: msg("Unsupported version"),
  broken: msg("Known broken version"),
} as const;

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
  resolve: MessageResolver = m,
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
} | null {
  const latestIsIncompatible =
    compatibility?.latestVersionStatus === "broken" ||
    compatibility?.latestVersionStatus === "unsupported";
  if (
    showCompatibility &&
    compatibility &&
    (compatibility.status === "graceful" ||
      compatibility.status === "unsupported" ||
      compatibility.status === "broken")
  ) {
    const targetVersion = compatibility.recommendedVersion;
    const recommendation = getProviderVersionLabel(targetVersion) ?? compatibility.recommendedRange;
    // Latest package versions cannot be updated into recommendations requiring another package.
    const isAlreadyLatest = advisory?.status === "current";
    return {
      title: resolve(COMPATIBILITY_TITLES[compatibility.status]),
      detail:
        compatibility.message ??
        (recommendation
          ? resolve(msg("Use {version} for full support.", { version: recommendation }))
          : resolve(msg("Update for full support."))),
      updateCommand:
        targetVersion || latestIsIncompatible || isAlreadyLatest
          ? null
          : (advisory?.updateCommand ?? null),
      emphasis: compatibility.status === "graceful" ? "normal" : "strong",
      targetVersion,
    };
  }
  if (
    !advisory ||
    advisory.status === "current" ||
    advisory.status === "unknown" ||
    latestIsIncompatible
  ) {
    return null;
  }

  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: resolve(msg("Update available")),
    detail:
      advisory.message ??
      (versionLabel
        ? resolve(msg("Update available: install {version}.", { version: versionLabel }))
        : resolve(msg("Update available: install the latest provider version."))),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}

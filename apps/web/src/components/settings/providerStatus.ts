import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";

import { translateDynamic } from "../../i18nCore";

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

export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: translateDynamic("providerSummary.checking"),
      detail: translateDynamic("providerSummary.checkingDetail"),
    };
  }
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: translateDynamic("providerSummary.disabled"),
      detail: provider.message ?? translateDynamic("providerSummary.disabledDetail"),
    };
  }
  if (!provider.installed) {
    return {
      headline: translateDynamic("providerSummary.notFound"),
      detail: provider.message ?? translateDynamic("providerSummary.notFoundDetail"),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel
        ? translateDynamic("providerSummary.unauthenticatedLabeled", { authLabel })
        : translateDynamic("providerSummary.unauthenticated"),
      detail: provider.message ?? null,
    };
  }
  if (isAntigravitySignInUnchecked(provider)) {
    return {
      headline: translateDynamic("providerSummary.antigravitySignIn"),
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: translateDynamic("providerSummary.warning"),
      detail: provider.message ?? translateDynamic("providerSummary.warningDetail"),
    };
  }
  if (provider.status === "error") {
    return {
      headline: translateDynamic("providerSummary.unavailable"),
      detail: provider.message ?? translateDynamic("providerSummary.unavailableDetail"),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel
        ? translateDynamic("providerSummary.authenticatedLabeled", { authLabel })
        : translateDynamic("providerSummary.authenticated"),
      detail: provider.message ?? null,
    };
  }
  return {
    headline: translateDynamic("providerSummary.available"),
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
  graceful: "providerAdvisory.compatGraceful",
  unsupported: "providerAdvisory.compatUnsupported",
  broken: "providerAdvisory.compatBroken",
} as const;

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
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
      title: translateDynamic(COMPATIBILITY_TITLES[compatibility.status]),
      detail:
        compatibility.message ??
        (recommendation
          ? translateDynamic("providerAdvisory.compatUseVersion", { version: recommendation })
          : translateDynamic("providerAdvisory.compatUpdate")),
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
    title: translateDynamic("providerAdvisory.updateAvailable"),
    detail:
      advisory.message ??
      (versionLabel
        ? translateDynamic("providerAdvisory.updateVersion", { version: versionLabel })
        : translateDynamic("providerAdvisory.updateLatest")),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}

export type DesktopCloudAuthOAuthStrategy = `oauth_${string}`;

export interface DesktopCloudAuthOAuthOption {
  readonly strategy: DesktopCloudAuthOAuthStrategy;
  readonly label: string;
  readonly providerId: string;
  readonly iconUrl: string | null;
}

interface ClerkOAuthProviderSetting {
  readonly enabled?: unknown;
  readonly authenticatable?: unknown;
  readonly strategy?: unknown;
  readonly name?: unknown;
  readonly logo_url?: unknown;
}

interface ClerkUserSettingsLike {
  readonly authenticatableSocialStrategies?: unknown;
  readonly social?: unknown;
}

interface ClerkEnvironmentLike {
  readonly userSettings?: ClerkUserSettingsLike;
}

interface ClerkLike {
  readonly __internal_environment?: ClerkEnvironmentLike;
  readonly environment?: ClerkEnvironmentLike;
}

const isClerkOAuthProviderSetting = (value: unknown): value is ClerkOAuthProviderSetting =>
  typeof value === "object" && value !== null;

const OAUTH_LABELS: Readonly<Record<string, string>> = {
  oauth_apple: "Apple",
  oauth_discord: "Discord",
  oauth_github: "GitHub",
  oauth_gitlab: "GitLab",
  oauth_google: "Google",
  oauth_linear: "Linear",
  oauth_microsoft: "Microsoft",
  oauth_slack: "Slack",
  oauth_x: "X",
};

// Mirrors Clerk UI's enabled-provider projection for the local desktop replacement:
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/hooks/useEnabledThirdPartyProviders.tsx
export function isDesktopCloudAuthOAuthStrategy(
  value: unknown,
): value is DesktopCloudAuthOAuthStrategy {
  return typeof value === "string" && value.startsWith("oauth_");
}

export function getDesktopCloudAuthOAuthStrategyLabel(
  strategy: DesktopCloudAuthOAuthStrategy,
): string {
  const mapped = OAUTH_LABELS[strategy];
  if (mapped) return mapped;
  return strategy
    .replace(/^oauth_custom_/, "")
    .replace(/^oauth_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveDesktopCloudAuthOAuthOptions(
  clerk: unknown,
): readonly DesktopCloudAuthOAuthOption[] {
  const environment =
    (clerk as ClerkLike | null | undefined)?.__internal_environment ??
    (clerk as ClerkLike | null | undefined)?.environment;
  const userSettings = environment?.userSettings;
  const strategies = userSettings?.authenticatableSocialStrategies;
  if (Array.isArray(strategies)) {
    return uniqueOptions(
      strategies
        .filter(isDesktopCloudAuthOAuthStrategy)
        .map((strategy) =>
          createOAuthOption(strategy, findProviderSetting(userSettings, strategy)),
        ),
    );
  }

  const social = userSettings?.social;
  if (!social || typeof social !== "object") {
    return [];
  }

  return uniqueOptions(
    Object.values(social as Record<string, ClerkOAuthProviderSetting>)
      .filter(isClerkOAuthProviderSetting)
      .filter((provider) => provider.enabled !== false && provider.authenticatable !== false)
      .map((provider) => {
        const strategy = isDesktopCloudAuthOAuthStrategy(provider.strategy)
          ? provider.strategy
          : null;
        if (!strategy) return null;
        return createOAuthOption(strategy, provider);
      })
      .filter((option): option is DesktopCloudAuthOAuthOption => option !== null),
  );
}

function findProviderSetting(
  userSettings: ClerkUserSettingsLike | undefined,
  strategy: DesktopCloudAuthOAuthStrategy,
): ClerkOAuthProviderSetting | undefined {
  const social = userSettings?.social;
  if (!social || typeof social !== "object") return undefined;

  return Object.values(social as Record<string, ClerkOAuthProviderSetting>)
    .filter(isClerkOAuthProviderSetting)
    .find((provider) => provider.strategy === strategy);
}

function createOAuthOption(
  strategy: DesktopCloudAuthOAuthStrategy,
  provider?: ClerkOAuthProviderSetting,
): DesktopCloudAuthOAuthOption {
  return {
    strategy,
    label:
      typeof provider?.name === "string" && provider.name.trim()
        ? provider.name
        : getDesktopCloudAuthOAuthStrategyLabel(strategy),
    providerId: strategy.replace(/^oauth_/, ""),
    iconUrl:
      typeof provider?.logo_url === "string" && provider.logo_url.trim() ? provider.logo_url : null,
  };
}

function uniqueOptions(
  options: readonly DesktopCloudAuthOAuthOption[],
): readonly DesktopCloudAuthOAuthOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.strategy)) return false;
    seen.add(option.strategy);
    return true;
  });
}

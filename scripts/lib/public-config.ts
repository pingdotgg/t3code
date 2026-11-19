// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface T3CodePublicConfig {
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly relayUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
  readonly hostedAppUrl: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../../..");

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(baseEnv, localEnv, rootEnv);
  const standalone = isStandaloneBuild(baseEnv, localEnv, rootEnv);
  if (standalone) {
    assertStandaloneConfig(config, baseEnv, localEnv, rootEnv);
  }

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(config.clerkPublishableKey
      ? {
          T3CODE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          T3CODE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
        }
      : {}),
    ...(config.clerkCliOAuthClientId
      ? {
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
        }
      : {}),
    ...(config.relayUrl
      ? {
          T3CODE_RELAY_URL: config.relayUrl,
          VITE_T3CODE_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          T3CODE_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          T3CODE_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
    ...(config.hostedAppUrl
      ? { T3CODE_HOSTED_APP_URL: config.hostedAppUrl, VITE_HOSTED_APP_URL: config.hostedAppUrl }
      : {}),
    ...(standalone ? { T3CODE_STANDALONE: "1" } : {}),
  };
}

const UPSTREAM_EAS_PROJECT_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const T3_OPERATED_DOMAINS = ["t3.codes", "t3.chat"];

function isStandaloneBuild(...sources: readonly Environment[]) {
  const value = firstNonEmpty(sources, "T3CODE_STANDALONE")?.toLowerCase();
  return value === "1" || value === "true";
}

export function isT3OperatedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      T3_OPERATED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
      (host === "u.expo.dev" && url.pathname.includes(UPSTREAM_EAS_PROJECT_ID))
    );
  } catch {
    return false;
  }
}

/** A standalone build must not bake in, or send users to, a service T3 operates. */
function assertStandaloneConfig(config: T3CodePublicConfig, ...sources: readonly Environment[]) {
  const urls: Record<string, string | undefined> = {
    T3CODE_RELAY_URL: config.relayUrl,
    T3CODE_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
    T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
    T3CODE_HOSTED_APP_URL: config.hostedAppUrl,
    EXPO_PUBLIC_MARKETING_SITE_URL: firstNonEmpty(sources, "EXPO_PUBLIC_MARKETING_SITE_URL"),
  };
  for (const [name, value] of Object.entries(urls)) {
    if (value && isT3OperatedUrl(value)) {
      throw new Error(`T3CODE_STANDALONE=1 does not allow ${name} to point at ${value}.`);
    }
  }
  if (firstNonEmpty(sources, "T3CODE_EAS_PROJECT_ID") === UPSTREAM_EAS_PROJECT_ID) {
    throw new Error("T3CODE_STANDALONE=1 needs your own T3CODE_EAS_PROJECT_ID, not T3's.");
  }
  const repository = firstNonEmpty(
    sources,
    "T3CODE_DESKTOP_UPDATE_REPOSITORY",
    "GITHUB_REPOSITORY",
  );
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error(
      "T3CODE_STANDALONE=1 needs T3CODE_DESKTOP_UPDATE_REPOSITORY (or GITHUB_REPOSITORY) set to your fork's owner/repo.",
    );
  }
  if (repository.split("/")[0]!.toLowerCase() === "pingdotgg") {
    throw new Error(`T3CODE_STANDALONE=1 does not allow the release repository ${repository}.`);
  }
}

function resolvePublicConfig(...sources: readonly Environment[]): T3CodePublicConfig {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "T3CODE_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayUrl: firstNonEmpty(sources, "T3CODE_RELAY_URL", "VITE_T3CODE_RELAY_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
    hostedAppUrl: firstNonEmpty(sources, "T3CODE_HOSTED_APP_URL", "VITE_HOSTED_APP_URL"),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
